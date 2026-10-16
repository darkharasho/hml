import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { NxMod, NxQuery, NxSort } from '../../../shared/types'
import { api, errorMessage } from '../api'
import { formatCount, installedNexusMod } from '../nxView'
import { useCurrentProfile, useStore } from '../store'
import { initials, UNSUPPORTED_LOADER } from '../tsView'
import { NexusDetail } from './NexusDetail'
import { Button, Icon } from './ui'

const PAGE_SIZE = 30
const DEBOUNCE_MS = 250

const SORTS: { value: NxSort; label: string }[] = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'downloads', label: 'Downloads' },
  { value: 'endorsements', label: 'Endorsements' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'name', label: 'Name' }
]

/** Results for one query, tagged with that query's key so stale pages are recognisable. */
interface Page {
  key: string
  items: NxMod[]
  total: number
}

/** The game's Nexus domain: undefined while loading, null when it isn't on Nexus Mods. */
type DomainState = { domain: string | null } | { error: string } | undefined

export function NexusBrowse({
  game,
  leading
}: {
  game: string
  leading?: ReactNode
}): React.JSX.Element {
  const [domainState, setDomainState] = useState<DomainState>(undefined)
  const [domainNonce, setDomainNonce] = useState(0)
  // The game menu's Nexus domain dialog changes the domain from outside this view.
  const domainVersion = useStore((s) => s.nxDomainVersion)

  useEffect(() => {
    let live = true
    api.nxGetDomain(game).then(
      (domain) => live && setDomainState({ domain }),
      (e) => live && setDomainState({ error: errorMessage(e) })
    )
    return () => {
      live = false
    }
  }, [game, domainNonce, domainVersion])

  const reloadDomain = (): void => {
    setDomainState(undefined)
    setDomainNonce((n) => n + 1)
  }

  if (domainState && 'domain' in domainState && domainState.domain) {
    return <NexusResults game={game} domain={domainState.domain} leading={leading} />
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {leading && <div className="flex items-center gap-2 px-6 pt-3">{leading}</div>}
      {!domainState ? (
        <div className="grid flex-1 place-items-center p-8 text-sm text-muted">
          Looking up this game on Nexus Mods…
        </div>
      ) : 'error' in domainState ? (
        <LoadError message={domainState.error} onRetry={reloadDomain} />
      ) : (
        <NoDomain game={game} onSaved={reloadDomain} />
      )}
    </div>
  )
}

function NexusResults({
  game,
  domain,
  leading
}: {
  game: string
  domain: string
  leading?: ReactNode
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [debounced, setDebounced] = useState('')
  const [sort, setSort] = useState<NxSort>('relevance')
  const [includeAdult, setIncludeAdult] = useState(false)
  // Bumped by Retry to force a fresh request for the same filters.
  const [nonce, setNonce] = useState(0)
  const [page, setPage] = useState<Page | null>(null)
  const [error, setError] = useState<{ key: string; message: string } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [detail, setDetail] = useState<NxMod | null>(null)
  const toast = useStore((s) => s.toast)
  // Every request takes a number; only the latest one may write results.
  const seq = useRef(0)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [text])

  const key = JSON.stringify([game, debounced, sort, includeAdult, nonce])

  useEffect(() => {
    const q: NxQuery = { text: debounced, sort, includeAdult, offset: 0, limit: PAGE_SIZE }
    const mine = ++seq.current
    api.nxSearch(game, q).then(
      (r) => {
        if (mine !== seq.current) return
        setPage({ ...r, key })
        setError(null)
      },
      (e) => {
        if (mine === seq.current) setError({ key, message: errorMessage(e) })
      }
    )
    // `key` covers nonce, so Retry re-runs this with unchanged filters.
  }, [game, debounced, sort, includeAdult, key])

  async function loadMore(): Promise<void> {
    if (!page || page.key !== key) return
    const mine = seq.current
    setLoadingMore(true)
    try {
      const r = await api.nxSearch(game, {
        text: debounced,
        sort,
        includeAdult,
        offset: page.items.length,
        limit: PAGE_SIZE
      })
      if (mine !== seq.current) return
      setPage((p) => (p && p.key === key ? { ...r, key, items: [...p.items, ...r.items] } : p))
    } catch (e) {
      if (mine === seq.current) toast('error', errorMessage(e))
    } finally {
      setLoadingMore(false)
    }
  }

  const current = page?.key === key ? page : null
  const failed = error?.key === key ? error : null
  const loading = !current && !failed
  const retry = (): void => setNonce((n) => n + 1)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-6 pt-3">
        {leading}
        <label className="relative min-w-56 flex-1">
          <span className="sr-only">Search Nexus Mods</span>
          <Icon
            name="search"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
          />
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search mods"
            className="h-9 w-full rounded-md border border-line bg-panel pr-3 pl-9 text-sm text-fg placeholder:text-muted focus:border-ember/60 focus:outline-none"
          />
        </label>
        <label className="sr-only" htmlFor="nx-sort">
          Sort by
        </label>
        <select
          id="nx-sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as NxSort)}
          className="h-9 rounded-md border border-line bg-panel px-2 text-sm text-fg"
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <label className="flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-muted hover:text-fg">
          <input
            type="checkbox"
            checked={includeAdult}
            onChange={(e) => setIncludeAdult(e.target.checked)}
            className="size-4 accent-ember"
          />
          Show adult content
        </label>
      </div>

      {failed && !page ? (
        <LoadError message={failed.message} onRetry={retry} />
      ) : !page ? (
        <div className="grid flex-1 place-items-center p-8 text-sm text-muted">
          Searching Nexus Mods…
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <p className="px-2 pb-2 text-xs text-muted" aria-live="polite">
            {failed ? (
              <span className="text-danger">
                {failed.message}{' '}
                <button type="button" className="underline hover:text-fg" onClick={retry}>
                  Retry
                </button>
              </span>
            ) : loading ? (
              'Searching…'
            ) : (
              `${page.total.toLocaleString('en')} ${page.total === 1 ? 'mod' : 'mods'}`
            )}
          </p>
          {page.items.length === 0 ? (
            <p className="px-2 py-10 text-center text-sm text-muted">
              No mods match. Try a shorter search.
            </p>
          ) : (
            <ul className={`flex flex-col transition-opacity ${loading ? 'opacity-50' : ''}`}>
              {page.items.map((m) => (
                <ResultRow key={m.modId} mod={m} onOpen={() => setDetail(m)} />
              ))}
            </ul>
          )}
          {current && current.items.length < current.total && (
            <div className="flex justify-center py-4">
              <Button disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </div>
      )}

      {detail && (
        <NexusDetail
          key={detail.modId}
          game={game}
          domain={domain}
          mod={detail}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  )
}

function ResultRow({ mod, onOpen }: { mod: NxMod; onOpen(): void }): React.JSX.Element {
  const profile = useCurrentProfile()
  const supported = useStore((s) => s.currentGame?.supported ?? false)
  const installing = useStore((s) => s.nxInstalling.includes(mod.modId))
  const nxInstall = useStore((s) => s.nxInstall)
  const installed = installedNexusMod(profile?.mods ?? [], mod.modId)

  return (
    <li
      onClick={onOpen}
      className="group flex cursor-pointer items-center gap-4 rounded-lg px-2 py-2.5 hover:bg-panel"
    >
      <NexusThumb url={mod.thumbnailUrl ?? mod.pictureUrl} name={mod.name} />
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
            {mod.name}
          </button>
          <span className="shrink-0 truncate text-xs text-muted">by {mod.author}</span>
          {mod.adultContent && <AdultBadge />}
        </div>
        <p className="line-clamp-2 text-xs text-muted">{mod.summary}</p>
      </div>
      <div className="flex w-20 shrink-0 flex-col items-end gap-0.5 text-xs text-muted tabular-nums">
        <span className="inline-flex items-center gap-1" title="Downloads">
          {formatCount(mod.downloads)}
          <Icon name="download" className="size-3.5" />
        </span>
        <span className="inline-flex items-center gap-1" title="Endorsements">
          {formatCount(mod.endorsements)}
          <Icon name="thumb" className="size-3.5" />
        </span>
      </div>
      <div className="flex w-28 shrink-0 justify-end" onClick={(e) => e.stopPropagation()}>
        {installed ? (
          <span className="text-right text-xs leading-tight text-teal">
            Installed
            <span className="block text-muted tabular-nums">{installed.version}</span>
          </span>
        ) : (
          <Button
            variant="ghost"
            disabled={!supported || installing}
            title={supported ? 'Install the newest main file' : UNSUPPORTED_LOADER}
            aria-label={`Install ${mod.name}`}
            onClick={() => void nxInstall(mod)}
          >
            {installing ? 'Installing…' : 'Install'}
          </Button>
        )}
      </div>
    </li>
  )
}

/** Nexus thumbnails are landscape; fall back to initials when missing or broken. */
export function NexusThumb({
  url,
  name,
  className = 'h-12 w-20'
}: {
  url: string | null
  name: string
  className?: string
}): React.JSX.Element {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const shape = `${className} shrink-0 overflow-hidden rounded-md bg-raised`
  if (url && failedUrl !== url) {
    return (
      <img
        src={url}
        alt=""
        loading="lazy"
        draggable={false}
        onError={() => setFailedUrl(url)}
        className={`${shape} object-cover`}
      />
    )
  }
  return (
    <span
      className={`${shape} grid place-items-center bg-[linear-gradient(160deg,#1f3a43,#132329)] text-sm font-bold text-muted`}
    >
      {initials(name)}
    </span>
  )
}

export function AdultBadge(): React.JSX.Element {
  return (
    <span className="shrink-0 rounded bg-danger/10 px-1.5 py-0.5 text-[11px] font-medium text-danger">
      Adult
    </span>
  )
}

function LoadError({ message, onRetry }: { message: string; onRetry(): void }): React.JSX.Element {
  return (
    <div className="grid flex-1 place-items-center p-8">
      <div className="max-w-sm text-center">
        <Icon name="warn" className="mx-auto size-7 text-danger" />
        <p className="mt-3 font-semibold">Couldn&apos;t load Nexus Mods</p>
        <p className="mt-1 text-sm text-muted select-text">{message}</p>
        <Button variant="primary" className="mt-5" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  )
}

function NoDomain({ game, onSaved }: { game: string; onSaved(): void }): React.JSX.Element {
  const displayName = useStore((s) => s.currentGame?.displayName ?? game)
  const toast = useStore((s) => s.toast)
  const [domain, setDomain] = useState('')
  const [saving, setSaving] = useState(false)
  const value = domain.trim()

  async function save(): Promise<void> {
    setSaving(true)
    try {
      await api.nxSetDomain(game, value)
      toast('success', `Saved Nexus domain ${value}`)
      onSaved()
    } catch (e) {
      toast('error', errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid flex-1 place-items-center p-8">
      <form
        className="w-full max-w-sm text-center"
        onSubmit={(e) => {
          e.preventDefault()
          if (value && !saving) void save()
        }}
      >
        <p className="font-semibold">{displayName} isn&apos;t on Nexus Mods.</p>
        <p className="mt-1 text-sm text-muted">
          If it is, enter the name from its address, like skyrimspecialedition in
          nexusmods.com/skyrimspecialedition.
        </p>
        <div className="mt-4 flex gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Nexus domain</span>
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="Nexus domain"
              spellCheck={false}
              autoComplete="off"
              className="h-9 w-full rounded-md border border-line bg-panel px-3 text-sm text-fg placeholder:text-muted focus:border-ember/60 focus:outline-none"
            />
          </label>
          <Button type="submit" variant={value ? 'primary' : 'ghost'} disabled={!value || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </div>
  )
}
