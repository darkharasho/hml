import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { CatalogEntry, CatListResult } from '../../../shared/ghCatalog'
import { api, errorMessage } from '../api'
import {
  CAT_SORTS,
  CATALOG_DOCS_URL,
  catCategories,
  catInstallState,
  CONFIRM_OWNERS_TITLE,
  confirmOwnersBody,
  filterCatalog,
  findCatInstalled,
  type CatSort
} from '../ghCatalogView'
import { useCurrentProfile, useStore, useSyncLocked } from '../store'
import { SYNC_LOCKED_NOTE } from '../syncView'
import { compactCount, relativeTime, UNSUPPORTED_LOADER } from '../tsView'
import { GithubCatalogDetail } from './GithubCatalogDetail'
import { PackageIcon, ProgressLine } from './PackageDetail'
import { Button, ConfirmDialog, Icon } from './ui'

/** Starts a catalog install: plans it, asks about unvetted owners, then installs. */
export interface CatInstallFlow {
  start(entry: CatalogEntry): void
  /** Key of the mod whose install is being planned. */
  planning: string | null
}

type Loaded = { key: string; result: CatListResult } | { key: string; error: string }

export function GithubBrowse({
  game,
  leading
}: {
  game: string
  leading?: ReactNode
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [sort, setSort] = useState<CatSort>('updated')
  const [category, setCategory] = useState<string | null>(null)
  const [nsfw, setNsfw] = useState(false)
  // Bumped by Retry and Refresh, which ask the Worker again instead of the 30-minute cache.
  const [nonce, setNonce] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [detail, setDetail] = useState<CatalogEntry | null>(null)
  const [confirm, setConfirm] = useState<{
    entry: CatalogEntry
    owners: string[]
    unavailable: string[]
  } | null>(null)
  const [planning, setPlanning] = useState<string | null>(null)
  const profileId = useStore((s) => s.currentProfile)
  const catInstall = useStore((s) => s.catInstall)
  const toast = useStore((s) => s.toast)
  const seq = useRef(0)
  const key = `${game}#${nonce}`

  useEffect(() => {
    const mine = ++seq.current
    api.catList(game, nonce > 0).then(
      (result) => mine === seq.current && setLoaded({ key, result }),
      (e) => mine === seq.current && setLoaded({ key, error: errorMessage(e) })
    )
  }, [game, nonce, key])

  const retry = (): void => setNonce((n) => n + 1)

  async function install(
    entry: CatalogEntry,
    owners: string[],
    unavailable: string[]
  ): Promise<void> {
    const r = await catInstall(entry, owners, unavailable)
    if (r?.kind === 'needs-confirm') setConfirm({ entry, owners: r.owners, unavailable })
  }

  async function start(entry: CatalogEntry): Promise<void> {
    if (!profileId || planning) return
    setPlanning(entry.key)
    try {
      const plan = await api.catPlanInstall(game, profileId, entry.key)
      if (plan.untrustedOwners.length > 0) {
        setConfirm({ entry, owners: plan.untrustedOwners, unavailable: plan.unavailable })
      } else {
        setPlanning(null)
        await install(entry, [], plan.unavailable)
      }
    } catch (e) {
      // A blocked mod's plan throws "Blocked by HML: <reason>".
      toast('error', errorMessage(e))
    } finally {
      setPlanning(null)
    }
  }

  const flow: CatInstallFlow = { start: (e) => void start(e), planning }
  const result = loaded && 'result' in loaded ? loaded.result : null
  const failed = loaded && 'error' in loaded ? loaded.error : null
  const refreshing = loaded?.key !== key
  const mods = result?.mods ?? []
  const categories = catCategories(mods.filter((m) => nsfw || !m.nsfw))
  // A chosen category that's no longer offered (hidden with NSFW, or gone on refresh) is dropped.
  const activeCategory = category !== null && categories.includes(category) ? category : null
  const shown = filterCatalog(mods, { text, category: activeCategory, sort, nsfw })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-6 pt-3">
        {leading}
        <label className="relative min-w-44 flex-1">
          <span className="sr-only">Search GitHub mods</span>
          <Icon
            name="search"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
          />
          <input
            type="search"
            data-find
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search mods"
            className="h-9 w-full rounded-md border border-line bg-panel pr-3 pl-9 text-sm text-fg placeholder:text-muted focus:border-ember/60 focus:outline-none"
          />
        </label>
        <label className="sr-only" htmlFor="gh-sort">
          Sort by
        </label>
        <select
          id="gh-sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as CatSort)}
          className="h-9 rounded-md border border-line bg-panel px-2 text-sm text-fg"
        >
          {CAT_SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <label className="flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-muted hover:text-fg">
          <input
            type="checkbox"
            checked={nsfw}
            onChange={(e) => setNsfw(e.target.checked)}
            className="size-4 accent-ember"
          />
          Show NSFW
        </label>
        <Button
          variant="quiet"
          disabled={refreshing}
          onClick={retry}
          aria-label={refreshing ? 'Refreshing the GitHub catalog' : 'Refresh the GitHub catalog'}
          title="Download the latest GitHub catalog"
        >
          <Icon name="refresh" className={`size-4 ${refreshing && loaded ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {categories.length > 0 && (
        <div role="group" aria-label="Categories" className="flex flex-wrap gap-1.5 px-6 pt-3">
          {categories.map((c) => {
            const on = activeCategory === c
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                onClick={() => setCategory(on ? null : c)}
                className={`h-7 rounded-full border px-2.5 text-xs transition-colors ${
                  on
                    ? 'border-ember bg-ember/15 text-ember'
                    : 'border-line text-muted hover:border-[#3a5664] hover:text-fg'
                }`}
              >
                {c}
              </button>
            )
          })}
        </div>
      )}

      {result?.offline && result.fetchedAt && (
        <p className="mx-6 mt-3 flex items-center gap-2 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
          <Icon name="warn" className="size-3.5 shrink-0" />
          Offline. Showing the catalog from {relativeTime(result.fetchedAt)}.
        </p>
      )}

      {!loaded ? (
        <div className="grid flex-1 place-items-center p-8 text-sm text-muted">
          Loading the GitHub catalog…
        </div>
      ) : failed || (result?.offline && !result.fetchedAt) ? (
        <div className="grid flex-1 place-items-center p-8">
          <div className="max-w-sm text-center">
            <Icon name="warn" className="mx-auto size-7 text-danger" />
            <p className="mt-3 font-semibold">Couldn&apos;t load the GitHub catalog</p>
            <p className="mt-1 text-sm text-muted select-text">
              {failed ?? "HML couldn't reach its catalog server. Check your connection."}
            </p>
            <Button variant="primary" className="mt-5" disabled={refreshing} onClick={retry}>
              Retry
            </Button>
          </div>
        </div>
      ) : mods.length === 0 ? (
        <div className="grid flex-1 place-items-center p-8">
          <div className="max-w-sm text-center">
            <Icon name="github" className="mx-auto size-7 text-muted" />
            <p className="mt-3 font-semibold">No GitHub mods for this game yet.</p>
            <Button
              variant="ghost"
              className="mt-4"
              onClick={() =>
                api.openExternal(CATALOG_DOCS_URL).catch((e) => toast('error', errorMessage(e)))
              }
            >
              <Icon name="external" />
              How to list a mod
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <p className="px-2 pb-2 text-xs text-muted" aria-live="polite">
            {`${shown.length.toLocaleString('en')} ${shown.length === 1 ? 'mod' : 'mods'}`}
          </p>
          {shown.length === 0 ? (
            <p className="px-2 py-10 text-center text-sm text-muted">
              No mods match. Try another category or a shorter search.
            </p>
          ) : (
            <ul className="flex flex-col">
              {shown.map((m) => (
                <ResultRow key={m.key} entry={m} flow={flow} onOpen={() => setDetail(m)} />
              ))}
            </ul>
          )}
        </div>
      )}

      {detail && (
        <GithubCatalogDetail
          key={detail.key}
          game={game}
          entry={detail}
          flow={flow}
          onClose={() => setDetail(null)}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={CONFIRM_OWNERS_TITLE}
          body={<p className="text-fg/90">{confirmOwnersBody(confirm.owners)}</p>}
          confirmLabel="Install"
          onConfirm={() => void install(confirm.entry, confirm.owners, confirm.unavailable)}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  )
}

/** The Install, Update or Installed control for a catalog mod, in a row or the detail view. */
export function CatInstallButton({
  entry,
  flow,
  compact = false
}: {
  entry: CatalogEntry
  flow: CatInstallFlow
  compact?: boolean
}): React.JSX.Element {
  const profile = useCurrentProfile()
  const supported = useStore((s) => s.currentGame?.supported ?? false)
  const installing = useStore((s) => s.catInstalling.includes(entry.key))
  const ghUpdates = useStore((s) => s.ghUpdates)
  const ghUpdating = useStore((s) => s.ghUpdating)
  const runGhUpdate = useStore((s) => s.ghUpdate)
  const locked = useSyncLocked()
  const mods = profile?.mods ?? []
  const state = catInstallState(entry, mods)
  const installed = findCatInstalled(entry, mods)
  // Updates go through the mod's own update check, which respects its update mode.
  const update = installed && ghUpdates.find((u) => u.modId === installed.id)
  const updating = !!installed && ghUpdating.includes(installed.id)

  if (installed && !(state === 'update' && update)) {
    return (
      <span className="text-right text-xs leading-tight text-teal">
        Installed
        <span className="block text-muted tabular-nums">{installed.version}</span>
      </span>
    )
  }
  const busy = installing || updating || flow.planning === entry.key
  const title = locked
    ? SYNC_LOCKED_NOTE
    : !supported
      ? UNSUPPORTED_LOADER
      : update
        ? `Update ${update.current} to ${update.latest}`
        : undefined
  return (
    <Button
      variant={update ? 'primary' : compact ? 'ghost' : 'primary'}
      disabled={!supported || busy || locked || (!update && flow.planning !== null)}
      title={title}
      aria-label={`${update ? 'Update' : 'Install'} ${entry.name}`}
      onClick={() => (update ? void runGhUpdate([update]) : flow.start(entry))}
    >
      {!compact && <Icon name="download" />}
      {busy ? (update ? 'Updating…' : 'Installing…') : update ? 'Update' : 'Install'}
    </Button>
  )
}

export function NsfwBadge(): React.JSX.Element {
  return (
    <span className="shrink-0 rounded bg-danger/10 px-1.5 py-0.5 text-[11px] font-medium text-danger">
      NSFW
    </span>
  )
}

/** The mod's icon; the owner's avatar when it has none, initials when neither loads. */
export function CatIcon({
  entry,
  className
}: {
  entry: CatalogEntry
  className?: string
}): React.JSX.Element {
  return (
    <PackageIcon
      pkg={{ iconUrl: entry.icon || entry.ownerAvatar, name: entry.name }}
      className={className}
    />
  )
}

function ResultRow({
  entry,
  flow,
  onOpen
}: {
  entry: CatalogEntry
  flow: CatInstallFlow
  onOpen(): void
}): React.JSX.Element {
  const installing = useStore((s) => s.catInstalling.includes(entry.key))
  return (
    <li
      onClick={onOpen}
      className="group flex cursor-pointer items-center gap-4 rounded-lg px-2 py-2.5 hover:bg-panel"
    >
      <CatIcon entry={entry} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onOpen()
            }}
            className="truncate text-left font-medium hover:text-ember"
          >
            {entry.name}
          </button>
          <span className="shrink-0 truncate text-xs text-muted">by {entry.owner}</span>
          {entry.nsfw && <NsfwBadge />}
        </div>
        {installing ? (
          <ProgressLine className="mt-0.5" />
        ) : (
          <p className="line-clamp-2 text-xs text-muted">{entry.description}</p>
        )}
      </div>
      <div className="flex w-20 shrink-0 flex-col items-end gap-0.5 text-xs text-muted tabular-nums">
        <span className="inline-flex items-center gap-1" title="Downloads">
          {compactCount(entry.downloads)}
          <Icon name="download" className="size-3.5" />
        </span>
        <span className="inline-flex items-center gap-1" title="Stars">
          {compactCount(entry.stars)}
          <Icon name="star" className="size-3.5" />
        </span>
      </div>
      <div className="flex w-28 shrink-0 justify-end" onClick={(e) => e.stopPropagation()}>
        <CatInstallButton entry={entry} flow={flow} compact />
      </div>
    </li>
  )
}
