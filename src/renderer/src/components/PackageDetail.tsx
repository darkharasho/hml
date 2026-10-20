import { useEffect, useState } from 'react'
import type { TsDocKind, TsPackage } from '../../../shared/types'
import { findInstalledMod } from '../../../shared/modIdentity'
import { compareVersions } from '../../../shared/version'
import { api, errorMessage } from '../api'
import { useCurrentProfile, useStore, useSyncLocked } from '../store'
import { SYNC_LOCKED_NOTE } from '../syncView'
import {
  compactCount,
  displayName,
  initials,
  newestVersion,
  ownInstalledVersion,
  relativeTime,
  splitDependency,
  UNSUPPORTED_LOADER
} from '../tsView'
import { Markdown } from './Markdown'
import { Button, Icon, Modal } from './ui'

/** Package icon with an initials fallback when the image is missing or fails to load. */
export function PackageIcon({
  pkg,
  className = 'size-12'
}: {
  pkg: Pick<TsPackage, 'iconUrl' | 'name'>
  className?: string
}): React.JSX.Element {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const shape = `${className} shrink-0 overflow-hidden rounded-md bg-raised`
  if (pkg.iconUrl && failedUrl !== pkg.iconUrl) {
    return (
      <img
        src={pkg.iconUrl}
        alt=""
        loading="lazy"
        draggable={false}
        onError={() => setFailedUrl(pkg.iconUrl)}
        className={`${shape} object-cover`}
      />
    )
  }
  return (
    <span
      className={`${shape} grid place-items-center bg-[linear-gradient(160deg,#1f3a43,#132329)] text-sm font-bold text-muted`}
    >
      {initials(pkg.name)}
    </span>
  )
}

/** The main-process progress line, shown while this package is installing. */
export function ProgressLine({ className = '' }: { className?: string }): React.JSX.Element {
  const progress = useStore((s) => s.progress)
  return (
    <p role="status" className={`flex min-w-0 items-center gap-2 text-xs text-ember ${className}`}>
      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-ember" />
      <span className="truncate">{progress ?? 'Preparing install…'}</span>
    </p>
  )
}

const NO_LOADERS: string[] = []

type Tab = TsDocKind | 'deps'
const TABS: { id: Tab; label: string }[] = [
  { id: 'readme', label: 'README' },
  { id: 'changelog', label: 'Changelog' },
  { id: 'deps', label: 'Dependencies' }
]

type Doc = { markdown: string | null } | { error: string } | null

/** A package version's README or changelog, fetched from Thunderstore when shown. */
function PackageDoc({
  fullName,
  version,
  kind
}: {
  fullName: string
  version: string
  kind: TsDocKind
}): React.JSX.Element {
  const [doc, setDoc] = useState<{ key: string; doc: Doc }>({ key: '', doc: null })
  const [nonce, setNonce] = useState(0)
  const key = `${fullName}@${version}/${kind}#${nonce}`
  useEffect(() => {
    let live = true
    api.tsGetDoc(fullName, version, kind).then(
      (markdown) => live && setDoc({ key, doc: { markdown } }),
      (e) => live && setDoc({ key, doc: { error: errorMessage(e) } })
    )
    return () => {
      live = false
    }
  }, [fullName, version, kind, key])

  const shown = doc.key === key ? doc.doc : null
  const frame = 'rounded-lg border border-line bg-ink/40 px-4 py-3'
  if (!shown) return <p className={frame}>Loading…</p>
  if ('error' in shown) {
    return (
      <div className={`${frame} flex items-center justify-between gap-3`}>
        <span className="text-danger">{shown.error}</span>
        <Button variant="ghost" onClick={() => setNonce((n) => n + 1)}>
          Retry
        </Button>
      </div>
    )
  }
  if (!shown.markdown) {
    return (
      <p className={frame}>
        {kind === 'readme' ? 'This version has no README.' : 'This version has no changelog.'}
      </p>
    )
  }
  return (
    <div className={frame}>
      <Markdown source={shown.markdown} />
    </div>
  )
}

export function PackageDetail({
  pkg,
  onClose
}: {
  pkg: TsPackage
  onClose(): void
}): React.JSX.Element {
  const profile = useCurrentProfile()
  const supported = useStore((s) => s.currentGame?.supported ?? false)
  const installing = useStore((s) => s.tsInstalling.includes(pkg.fullName))
  const tsInstall = useStore((s) => s.tsInstall)
  const locked = useSyncLocked()
  const toast = useStore((s) => s.toast)
  const loaderIds = useStore((s) => s.currentGame?.loaderPackageIds) ?? NO_LOADERS
  const [version, setVersion] = useState(() => newestVersion(pkg)?.version ?? '')
  const [websiteRejected, setWebsiteRejected] = useState(false)
  const [tab, setTab] = useState<Tab>('readme')

  const mods = profile?.mods ?? []
  const selected = pkg.versions.find((v) => v.version === version)
  const installedVersion = findInstalledMod(mods, pkg.fullName, loaderIds)?.version ?? null
  // Only the package's own copy blocks installing that version; a GitHub stand-in that provides
  // it can be replaced by the Thunderstore package at any version.
  const isInstalled = ownInstalledVersion(pkg, mods, loaderIds) === version
  // An older version than the newest is held there once installed (see tsInstall).
  const older = !!selected && selected !== newestVersion(pkg)
  const rollback =
    older && installedVersion !== null && compareVersions(version, installedVersion) < 0

  async function openWebsite(): Promise<void> {
    try {
      await api.openExternal(pkg.websiteUrl)
    } catch {
      // Only Thunderstore and GitHub links open directly; show anything else for copying.
      setWebsiteRejected(true)
    }
  }

  return (
    <Modal
      title={displayName(pkg.name)}
      onClose={onClose}
      width="w-[760px]"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          {installing ? <ProgressLine /> : <span />}
          <div className="flex shrink-0 gap-2">
            <Button variant="quiet" onClick={onClose}>
              Close
            </Button>
            <Button
              variant="primary"
              disabled={!supported || installing || isInstalled || !selected || locked}
              title={locked ? SYNC_LOCKED_NOTE : supported ? undefined : UNSUPPORTED_LOADER}
              onClick={() => void tsInstall(pkg, version)}
            >
              <Icon name="download" />
              {installing
                ? 'Installing…'
                : isInstalled
                  ? 'Installed'
                  : rollback
                    ? `Roll back to ${version}`
                    : `Install ${version}`}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex gap-4">
        <PackageIcon pkg={pkg} className="size-20" />
        <div className="min-w-0 flex-1">
          <p>
            by <span className="text-fg">{pkg.owner}</span>
          </p>
          <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
            <span className="inline-flex items-center gap-1" title="Downloads">
              <Icon name="download" className="size-3.5" />
              {compactCount(pkg.totalDownloads)}
            </span>
            <span className="inline-flex items-center gap-1" title="Rating">
              <Icon name="thumb" className="size-3.5" />
              {compactCount(pkg.rating)}
            </span>
            <span>Updated {relativeTime(pkg.dateUpdated)}</span>
          </p>
          {(pkg.categories.length > 0 || pkg.isDeprecated) && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {pkg.isDeprecated && (
                <li className="flex">
                  <DeprecatedBadge />
                </li>
              )}
              {pkg.categories.map((c) => (
                <li key={c} className="rounded bg-raised px-1.5 py-0.5 text-[11px] text-fg/80">
                  {c}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <p className="mt-4 text-fg/90 select-text">{pkg.description || 'No description.'}</p>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="ghost"
          onClick={() =>
            api.openExternal(pkg.packageUrl).catch((e) => toast('error', errorMessage(e)))
          }
        >
          <Icon name="external" />
          Open on Thunderstore
        </Button>
        {pkg.websiteUrl && !websiteRejected && (
          <Button variant="ghost" onClick={() => void openWebsite()} title={pkg.websiteUrl}>
            <Icon name="external" />
            Website
          </Button>
        )}
      </div>
      {pkg.websiteUrl && websiteRejected && (
        <label className="mt-3 block">
          <span className="text-xs">
            HML only opens Thunderstore and GitHub links. Copy the website:
          </span>
          <span className="mt-1 flex gap-2">
            <input
              readOnly
              value={pkg.websiteUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="h-9 min-w-0 flex-1 rounded-md border border-line bg-ink px-3 text-sm text-fg"
            />
            <Button
              variant="ghost"
              aria-label="Copy website address"
              onClick={() =>
                navigator.clipboard
                  .writeText(pkg.websiteUrl)
                  .then(() => toast('info', 'Copied website address'))
                  .catch((e) => toast('error', errorMessage(e)))
              }
            >
              <Icon name="copy" />
            </Button>
          </span>
        </label>
      )}

      <div className="mt-5 flex items-center justify-between gap-3 border-t border-line pt-4">
        <label htmlFor="ts-version" className="font-medium text-fg">
          Version
        </label>
        <select
          id="ts-version"
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          className="h-9 rounded-md border border-line bg-ink px-2 text-sm text-fg tabular-nums"
        >
          {pkg.versions.map((v, i) => (
            <option key={v.version} value={v.version}>
              {v.version}
              {i === 0 ? ' (newest)' : ''}
              {v.version === installedVersion ? ' (installed)' : ''}
            </option>
          ))}
        </select>
      </div>
      {older && !isInstalled && (
        <p className="mt-2 text-xs text-muted">
          An older version stays held once installed: HML won&apos;t offer updates for it until you
          install the newest or turn off Hold.
        </p>
      )}

      <div
        role="tablist"
        aria-label="Package details"
        className="mt-4 flex gap-1 border-b border-line"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === t.id ? 'border-ember text-fg' : 'border-transparent hover:text-fg'
            }`}
          >
            {t.label}
            {t.id === 'deps' && (
              <span className="ml-1.5 text-xs font-normal text-muted tabular-nums">
                {selected?.dependencies.length ?? 0}
              </span>
            )}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="mt-3">
        {tab === 'deps' ? (
          selected && selected.dependencies.length > 0 ? (
            <ul className="rounded-lg border border-line">
              {selected.dependencies.map((dep) => {
                const d = splitDependency(dep)
                return (
                  <li
                    key={dep}
                    className="flex items-baseline gap-2 border-b border-line px-3 py-2 last:border-b-0"
                  >
                    <span className="truncate text-fg">{displayName(d.name)}</span>
                    <span className="truncate text-xs">by {d.owner}</span>
                    <span className="ml-auto shrink-0 text-xs tabular-nums">
                      {findInstalledMod(mods, d.fullName, loaderIds) && (
                        <span className="mr-2 text-teal">Installed</span>
                      )}
                      {d.version}
                    </span>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p>None. This version installs on its own.</p>
          )
        ) : (
          <PackageDoc fullName={pkg.fullName} version={version} kind={tab} />
        )}
      </div>
    </Modal>
  )
}

export function DeprecatedBadge(): React.JSX.Element {
  return (
    <span className="shrink-0 rounded bg-danger/10 px-1.5 py-0.5 text-[11px] font-medium text-danger">
      Deprecated
    </span>
  )
}
