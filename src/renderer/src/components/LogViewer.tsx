import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { InstalledMod } from '../../../shared/types'
import { isProblem, modForEntry, parseLog, type LogEntry } from '../../../shared/modLog'
import { api, errorMessage } from '../api'
import { useStore } from '../store'
import { displayName } from '../tsView'
import { Button, Icon } from './ui'

/** Lines kept in view; older ones drop off the top. */
const MAX_LINES = 20_000
/** Entries drawn at once; the rest are a filter or a scroll away. */
const MAX_SHOWN = 1500
const POLL_MS = 1000
/** Lines of a long entry (a stack trace) shown before "Show more". */
const PREVIEW_LINES = 4

const LEVEL_STYLE: Record<LogEntry['level'], string> = {
  fatal: 'bg-danger/20 text-danger',
  error: 'bg-danger/10 text-danger',
  warning: 'bg-warn/10 text-warn',
  message: 'bg-teal/10 text-teal',
  info: 'bg-fg/5 text-muted',
  debug: 'bg-fg/5 text-muted/70'
}

type Shown = 'all' | 'problems' | 'errors'

interface Tail {
  key: string
  file: string | null
  lines: string[]
  /** Line number of lines[0] in what has been read since the last reset. */
  base: number
  next: number
}

/** The Log tab: the mod loader's log as the game writes it, with errors traced to their mod. */
export function LogViewer({
  game,
  profileId,
  mods,
  active
}: {
  game: string
  profileId: string
  mods: InstalledMod[]
  active: boolean
}): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const key = `${game}/${profileId}`
  const [tail, setTail] = useState<Tail | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [shown, setShown] = useState<Shown>('all')
  const [modFilter, setModFilter] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [follow, setFollow] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)
  const current = tail?.key === key ? tail : null

  useEffect(() => {
    if (!active) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let state: Tail | null = null
    const poll = async (): Promise<void> => {
      try {
        if (document.visibilityState === 'visible') {
          const r = await api.readModLog(game, profileId, state?.next ?? 0)
          if (!live) return
          setFailure(null)
          const fresh = r.text === '' ? [] : r.text.replace(/\r?\n$/, '').split(/\r?\n/)
          // A loader that starts a new log each run (lovely) moves to another file. This read
          // went from the old file's offset, so drop it; the next one reads the new file's tail.
          if (state && r.file !== state.file && !r.reset) {
            state = { ...state, file: r.file, next: 0 }
          } else if (r.reset || !state) {
            state = { key, file: r.file, lines: fresh, base: 0, next: r.next }
          } else if (fresh.length > 0 || r.next !== state.next) {
            const lines = [...state.lines, ...fresh]
            const drop = Math.max(0, lines.length - MAX_LINES)
            state = {
              ...state,
              lines: drop ? lines.slice(drop) : lines,
              base: state.base + drop,
              next: r.next
            }
          }
          setTail(state)
        }
      } catch (e) {
        if (live) setFailure(errorMessage(e))
      }
      if (live) timer = setTimeout(() => void poll(), POLL_MS)
    }
    void poll()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [active, game, profileId, key])

  const entries = useMemo(
    () => (current ? parseLog(current.lines.join('\n'), current.base) : []),
    [current]
  )
  const withMods = useMemo(
    () => entries.map((e) => ({ entry: e, mod: modForEntry(e, mods) })),
    [entries, mods]
  )
  const errors = withMods.filter((x) => x.entry.level === 'error' || x.entry.level === 'fatal')
  const warnings = withMods.filter((x) => x.entry.level === 'warning')
  // Mods with problems, most first: the quickest way to see what's breaking.
  const blamed = new Map<string, { mod: InstalledMod; count: number }>()
  for (const { entry, mod } of withMods) {
    if (!mod || !isProblem(entry.level)) continue
    const b = blamed.get(mod.id) ?? { mod, count: 0 }
    b.count++
    blamed.set(mod.id, b)
  }
  const ranked = [...blamed.values()].sort((a, b) => b.count - a.count)
  const needle = query.trim().toLowerCase()
  const filtered = withMods.filter(
    ({ entry, mod }) =>
      (shown === 'all' ||
        (shown === 'problems'
          ? isProblem(entry.level)
          : entry.level === 'error' || entry.level === 'fatal')) &&
      (!modFilter || mod?.id === modFilter) &&
      (!needle ||
        entry.text.toLowerCase().includes(needle) ||
        entry.source.toLowerCase().includes(needle))
  )
  const visible = filtered.slice(-MAX_SHOWN)

  // Following keeps the newest line in view as the game writes.
  useLayoutEffect(() => {
    const el = listRef.current
    if (follow && el && active) el.scrollTop = el.scrollHeight
  }, [follow, active, visible.length, current?.next])

  const openLog = (): void =>
    void api.openModLog(game, profileId).catch((e) => toast('error', errorMessage(e)))

  if (current && current.file === null) {
    return (
      <div className="grid flex-1 place-items-center p-8 text-center text-sm text-muted">
        HML doesn&apos;t know where this game&apos;s mod loader writes its log.
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-6 py-2.5">
        <div className="flex rounded-md border border-line p-0.5 text-xs" role="group">
          {(
            [
              ['all', `All ${entries.length}`],
              ['problems', `Problems ${errors.length + warnings.length}`],
              ['errors', `Errors ${errors.length}`]
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={shown === value}
              onClick={() => setShown(value)}
              className={`rounded px-2.5 py-1 tabular-nums ${
                shown === value ? 'bg-raised text-fg' : 'text-muted hover:text-fg'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="relative w-56">
          <span className="sr-only">Search the log</span>
          <Icon
            name="search"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted"
          />
          <input
            type="search"
            data-find
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the log"
            className="h-8 w-full rounded-md border border-line bg-panel pr-2 pl-8 text-sm text-fg placeholder:text-muted focus:border-ember/70 focus:outline-none"
          />
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
            className="size-3.5 accent-ember"
          />
          Follow
        </label>
        <Button variant="quiet" className="ml-auto h-8" onClick={openLog}>
          <Icon name="external" />
          Open log file
        </Button>
      </div>

      {ranked.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-6 py-2 text-xs">
          <span className="text-muted">Problems by mod:</span>
          {ranked.slice(0, 8).map(({ mod, count }) => (
            <button
              key={mod.id}
              type="button"
              aria-pressed={modFilter === mod.id}
              onClick={() => setModFilter(modFilter === mod.id ? null : mod.id)}
              className={`rounded-full border px-2 py-0.5 tabular-nums ${
                modFilter === mod.id
                  ? 'border-ember/60 bg-ember/15 text-fg'
                  : 'border-line text-muted hover:text-fg'
              }`}
            >
              {displayName(mod.name)} {count}
            </button>
          ))}
        </div>
      )}

      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget
          const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          if (atEnd !== follow) setFollow(atEnd)
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-2 font-mono text-[12px] leading-relaxed"
      >
        {failure ? (
          <p className="p-2 font-sans text-sm text-danger">{failure}</p>
        ) : !current ? (
          <p className="p-2 font-sans text-sm text-muted">Reading the log…</p>
        ) : entries.length === 0 ? (
          <p className="p-2 font-sans text-sm text-muted">
            No log yet. Start the game modded and its log shows here as it runs.
          </p>
        ) : visible.length === 0 ? (
          <p className="p-2 font-sans text-sm text-muted">Nothing matches.</p>
        ) : (
          <>
            {filtered.length > visible.length && (
              <p className="p-2 font-sans text-xs text-muted">
                Showing the last {visible.length} of {filtered.length} entries.
              </p>
            )}
            <ul>
              {visible.map(({ entry, mod }) => (
                <LogRow key={entry.line} entry={entry} mod={mod} />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}

function LogRow({ entry, mod }: { entry: LogEntry; mod: InstalledMod | null }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const lines = entry.text.split('\n')
  const long = lines.length > PREVIEW_LINES
  const text = long && !expanded ? lines.slice(0, PREVIEW_LINES).join('\n') : entry.text
  return (
    <li
      className={`flex gap-2 rounded px-2 py-0.5 hover:bg-panel ${
        entry.level === 'error' || entry.level === 'fatal' ? 'bg-danger/5' : ''
      }`}
    >
      <span
        className={`mt-0.5 h-fit w-16 shrink-0 rounded px-1 text-center text-[10px] font-semibold uppercase ${LEVEL_STYLE[entry.level]}`}
      >
        {entry.level}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          {entry.source && <span className="text-muted">{entry.source}</span>}
          {mod && displayName(mod.name) !== entry.source && (
            <span className="rounded bg-ember/10 px-1 font-sans text-[10px] font-medium text-ember">
              {displayName(mod.name)}
            </span>
          )}
        </div>
        <pre className="break-words whitespace-pre-wrap text-fg/90">{text}</pre>
        {long && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="font-sans text-[11px] text-ember hover:underline"
          >
            {expanded ? 'Show less' : `Show ${lines.length - PREVIEW_LINES} more lines`}
          </button>
        )}
      </div>
    </li>
  )
}
