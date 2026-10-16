import { useEffect, useRef, useState } from 'react'
import type { TsPackage, TsQuery, TsSearchResult, TsSort } from '../../../shared/types'
import { api, errorMessage } from '../api'
import { useCurrentProfile, useStore } from '../store'
import {
  compactCount,
  displayName,
  installState,
  relativeTime,
  UNSUPPORTED_LOADER
} from '../tsView'
import { DeprecatedBadge, PackageDetail, PackageIcon, ProgressLine } from './PackageDetail'
import { Button, Icon } from './ui'

const PAGE_SIZE = 50
const DEBOUNCE_MS = 250

const SORTS: { value: TsSort; label: string }[] = [
  { value: 'top', label: 'Top rated' },
  { value: 'downloads', label: 'Most downloaded' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'name', label: 'Name' }
]

type Filters = Omit<TsQuery, 'offset' | 'limit'>

/** Results for one query, tagged with that query's key so stale pages are recognisable. */
interface Page extends Omit<TsSearchResult, 'items'> {
  key: string
  items: TsPackage[]
}

export function Browse({ game }: { game: string }): React.JSX.Element {
  const [text, setText] = useState('')
  const [debounced, setDebounced] = useState('')
  const [sort, setSort] = useState<TsSort>('top')
  const [categories, setCategories] = useState<string[]>([])
  const [includeDeprecated, setIncludeDeprecated] = useState(false)
  const [includeNsfw, setIncludeNsfw] = useState(false)
  // Bumped by Retry and Refresh to force a fresh request for the same filters.
  const [nonce, setNonce] = useState(0)
  const [page, setPage] = useState<Page | null>(null)
  const [error, setError] = useState<{ key: string; message: string } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [detail, setDetail] = useState<TsPackage | null>(null)
  const checkUpdates = useStore((s) => s.checkUpdates)
  const toast = useStore((s) => s.toast)
  // Every request takes a number; only the latest one may write results.
  const seq = useRef(0)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [text])

  const filters: Filters = { text: debounced, categories, sort, includeDeprecated, includeNsfw }
  const key = JSON.stringify([game, filters, nonce])

  useEffect(() => {
    const q: TsQuery = {
      text: debounced,
      categories,
      sort,
      includeDeprecated,
      includeNsfw,
      offset: 0,
      limit: PAGE_SIZE
    }
    const mine = ++seq.current
    api.tsSearch(game, q).then(
      (r) => {
        if (mine !== seq.current) return
        setPage({ ...r, key })
        setError(null)
      },
      (e) => {
        if (mine === seq.current) setError({ key, message: errorMessage(e) })
      }
    )
    // `key` covers nonce, so Retry and Refresh re-run this with unchanged filters.
  }, [game, debounced, categories, sort, includeDeprecated, includeNsfw, key])

  async function loadMore(): Promise<void> {
    if (!page || page.key !== key) return
    const mine = seq.current
    setLoadingMore(true)
    try {
      const r = await api.tsSearch(game, {
        ...filters,
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

  async function refresh(): Promise<void> {
    setRefreshing(true)
    try {
      await api.tsRefresh(game)
      setNonce((n) => n + 1)
      void checkUpdates()
    } catch (e) {
      toast('error', errorMessage(e))
    } finally {
      setRefreshing(false)
    }
  }

  function toggleCategory(c: string): void {
    setCategories((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]))
  }

  const current = page?.key === key ? page : null
  const failed = error?.key === key ? error : null
  const loading = !current && !failed

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-6 pt-3">
        <label className="relative min-w-56 flex-1">
          <span className="sr-only">Search Thunderstore</span>
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
        <label className="sr-only" htmlFor="ts-sort">
          Sort by
        </label>
        <select
          id="ts-sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as TsSort)}
          className="h-9 rounded-md border border-line bg-panel px-2 text-sm text-fg"
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <Check
          label="Show deprecated"
          checked={includeDeprecated}
          onChange={setIncludeDeprecated}
        />
        <Check label="Show NSFW" checked={includeNsfw} onChange={setIncludeNsfw} />
        <Button
          variant="quiet"
          disabled={refreshing}
          onClick={() => void refresh()}
          title="Download the latest package list from Thunderstore"
        >
          <Icon name="refresh" className={`size-4 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {page && page.categories.length > 0 && (
        <div role="group" aria-label="Categories" className="flex flex-wrap gap-1.5 px-6 pt-3">
          {page.categories.map((c) => {
            const on = categories.includes(c)
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                onClick={() => toggleCategory(c)}
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

      {page?.stale && (
        <p className="mx-6 mt-3 flex items-center gap-2 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
          <Icon name="warn" className="size-3.5 shrink-0" />
          Thunderstore is unreachable — showing the cached list from {relativeTime(page.fetchedAt)}
        </p>
      )}

      {failed && !page ? (
        <div className="grid flex-1 place-items-center p-8">
          <div className="max-w-sm text-center">
            <Icon name="warn" className="mx-auto size-7 text-danger" />
            <p className="mt-3 font-semibold">Couldn&apos;t load Thunderstore mods</p>
            <p className="mt-1 text-sm text-muted select-text">{failed.message}</p>
            <Button variant="primary" className="mt-5" onClick={() => setNonce((n) => n + 1)}>
              Retry
            </Button>
          </div>
        </div>
      ) : !page ? (
        <div className="grid flex-1 place-items-center p-8 text-sm text-muted">
          Loading the Thunderstore package list…
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <p className="px-2 pb-2 text-xs text-muted" aria-live="polite">
            {failed ? (
              <span className="text-danger">
                {failed.message}{' '}
                <button
                  type="button"
                  className="underline hover:text-fg"
                  onClick={() => setNonce((n) => n + 1)}
                >
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
              No mods match. Try fewer categories or a shorter search.
            </p>
          ) : (
            <ul className={`flex flex-col transition-opacity ${loading ? 'opacity-50' : ''}`}>
              {page.items.map((p) => (
                <ResultRow key={p.fullName} pkg={p} onOpen={() => setDetail(p)} />
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
        <PackageDetail key={detail.fullName} pkg={detail} onClose={() => setDetail(null)} />
      )}
    </div>
  )
}

function ResultRow({ pkg, onOpen }: { pkg: TsPackage; onOpen(): void }): React.JSX.Element {
  const profile = useCurrentProfile()
  const supported = useStore((s) => s.currentGame?.supported ?? false)
  const installing = useStore((s) => s.tsInstalling.includes(pkg.fullName))
  const tsInstall = useStore((s) => s.tsInstall)
  const loaderIds = useStore((s) => s.currentGame?.loaderPackageIds)
  const state = installState(pkg, profile?.mods ?? [], loaderIds)
  const name = displayName(pkg.name)

  return (
    <li
      onClick={onOpen}
      className="group flex cursor-pointer items-center gap-4 rounded-lg px-2 py-2.5 hover:bg-panel"
    >
      <PackageIcon pkg={pkg} />
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
            {name}
          </button>
          <span className="shrink-0 truncate text-xs text-muted">by {pkg.owner}</span>
          {pkg.isDeprecated && <DeprecatedBadge />}
        </div>
        {installing ? (
          <ProgressLine className="mt-0.5" />
        ) : (
          <p className="line-clamp-2 text-xs text-muted">{pkg.description}</p>
        )}
      </div>
      <div className="flex w-20 shrink-0 flex-col items-end gap-0.5 text-xs text-muted tabular-nums">
        <span className="inline-flex items-center gap-1" title="Downloads">
          {compactCount(pkg.totalDownloads)}
          <Icon name="download" className="size-3.5" />
        </span>
        <span className="inline-flex items-center gap-1" title="Rating">
          {compactCount(pkg.rating)}
          <Icon name="thumb" className="size-3.5" />
        </span>
      </div>
      <div className="flex w-28 shrink-0 justify-end" onClick={(e) => e.stopPropagation()}>
        {state.kind === 'installed' ? (
          <span className="text-right text-xs leading-tight text-teal">
            Installed
            <span className="block text-muted tabular-nums">{state.version}</span>
          </span>
        ) : (
          <Button
            variant={state.kind === 'update' ? 'primary' : 'ghost'}
            disabled={!supported || installing}
            title={
              !supported
                ? UNSUPPORTED_LOADER
                : state.kind === 'update'
                  ? `Update ${state.installed} to ${state.latest}`
                  : undefined
            }
            aria-label={`${state.kind === 'update' ? 'Update' : 'Install'} ${name}`}
            onClick={() => void tsInstall(pkg)}
          >
            {installing ? 'Installing…' : state.kind === 'update' ? 'Update' : 'Install'}
          </Button>
        )}
      </div>
    </li>
  )
}

function Check({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange(v: boolean): void
}): React.JSX.Element {
  return (
    <label className="flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-muted hover:text-fg">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-ember"
      />
      {label}
    </label>
  )
}
