import { useEffect, useState } from 'react'
import type { CatalogEntry } from '../../../shared/ghCatalog'
import { api, errorMessage } from '../api'
import { catReportUrl, catRepoUrl, listedFromPrerelease } from '../ghCatalogView'
import { useStore } from '../store'
import { compactCount, relativeTime } from '../tsView'
import {
  CatIcon,
  CatInstallButton,
  NsfwBadge,
  PrereleaseBadge,
  type CatInstallFlow
} from './GithubBrowse'
import { Markdown } from './Markdown'
import { ProgressLine } from './PackageDetail'
import { Button, Icon, Modal } from './ui'

type Readme = { markdown: string } | { error: string } | null

/** A catalog mod's README, fetched when the detail view opens. */
function CatReadme({ game, entry }: { game: string; entry: CatalogEntry }): React.JSX.Element {
  const [doc, setDoc] = useState<{ key: string; doc: Readme }>({ key: '', doc: null })
  const [nonce, setNonce] = useState(0)
  const key = `${entry.key}#${nonce}`
  useEffect(() => {
    if (!entry.readme) return
    let live = true
    api.catReadme(game, entry.key).then(
      (markdown) => live && setDoc({ key, doc: { markdown } }),
      (e) => live && setDoc({ key, doc: { error: errorMessage(e) } })
    )
    return () => {
      live = false
    }
  }, [game, entry.key, entry.readme, key])

  const frame = 'rounded-lg border border-line bg-ink/40 px-4 py-3'
  if (!entry.readme) return <p className={frame}>This mod has no README.</p>
  const shown = doc.key === key ? doc.doc : null
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
  if (!shown.markdown.trim()) return <p className={frame}>This mod has no README.</p>
  return (
    <div className={frame}>
      <Markdown source={shown.markdown} />
    </div>
  )
}

export function GithubCatalogDetail({
  game,
  entry,
  flow,
  onClose
}: {
  game: string
  entry: CatalogEntry
  flow: CatInstallFlow
  onClose(): void
}): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const installing = useStore((s) => s.catInstalling.includes(entry.key))
  const [now] = useState(() => Date.now())
  const open = (url: string): void =>
    void api.openExternal(url).catch((e) => toast('error', errorMessage(e)))

  return (
    <Modal
      title={entry.name}
      onClose={onClose}
      width="w-[760px]"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          {installing ? <ProgressLine /> : <span />}
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="quiet" onClick={onClose}>
              Close
            </Button>
            <CatInstallButton entry={entry} flow={flow} />
          </div>
        </div>
      }
    >
      <div className="flex gap-4">
        <CatIcon entry={entry} className="size-20" />
        <div className="min-w-0 flex-1">
          <p>
            by <span className="text-fg">{entry.owner}</span>
            <span className="ml-2 text-xs">
              {entry.owner}/{entry.repo}
            </span>
          </p>
          <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
            <span className="inline-flex items-center gap-1" title="Stars">
              <Icon name="star" className="size-3.5" />
              {compactCount(entry.stars)}
            </span>
            <span className="inline-flex items-center gap-1" title="Downloads">
              <Icon name="download" className="size-3.5" />
              {compactCount(entry.downloads)}
            </span>
            <span title={entry.latest.tag}>
              Released {entry.latest.version} {relativeTime(entry.latest.publishedAt, now)}
            </span>
            <span>Repo created {relativeTime(entry.repoCreatedAt, now)}</span>
          </p>
          {(entry.categories.length > 0 || entry.nsfw || listedFromPrerelease(entry)) && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {listedFromPrerelease(entry) && (
                <li className="flex">
                  <PrereleaseBadge />
                </li>
              )}
              {entry.nsfw && (
                <li className="flex">
                  <NsfwBadge />
                </li>
              )}
              {entry.categories.map((c) => (
                <li key={c} className="rounded bg-raised px-1.5 py-0.5 text-[11px] text-fg/80">
                  {c}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <p className="mt-4 text-fg/90 select-text">{entry.description || 'No description.'}</p>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="ghost" onClick={() => open(catRepoUrl(entry))}>
          <Icon name="github" />
          View on GitHub
        </Button>
        <Button
          variant="ghost"
          title="Tell HML about a harmful or broken mod"
          onClick={() => open(catReportUrl(entry.owner, entry.repo))}
        >
          <Icon name="warn" />
          Report
        </Button>
      </div>

      {entry.dependencies.length > 0 && (
        <>
          <h3 className="mt-5 border-t border-line pt-4 font-medium text-fg">
            Dependencies
            <span className="ml-2 text-xs font-normal text-muted tabular-nums">
              {entry.dependencies.length}
            </span>
          </h3>
          <ul className="mt-2 rounded-lg border border-line">
            {entry.dependencies.map((d) => (
              <li
                key={d}
                className="truncate border-b border-line px-3 py-2 text-xs text-fg last:border-b-0"
              >
                {d}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 className="mt-5 border-t border-line pt-4 font-medium text-fg">README</h3>
      <div className="mt-2">
        <CatReadme game={game} entry={entry} />
      </div>
    </Modal>
  )
}
