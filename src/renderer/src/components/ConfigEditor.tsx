import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ConfigFile } from '../../../shared/types'
import { hasCfgSettings, parseCfg, setCfgValues, type CfgEntry } from '../../../shared/bepinexCfg'
import { api, errorMessage } from '../api'
import { controlFor, splitConfigPath, splitFlags } from '../configView'
import { useStore } from '../store'
import { Button, ConfirmDialog, Icon, Spinner, Toggle } from './ui'

const FIELD =
  'h-8 rounded-md border border-line bg-ink px-2 text-sm text-fg focus:border-ember/70 focus:outline-none'

/** The Config tab: the profile's config files, each edited as a form or as plain text. */
export function ConfigEditor({
  game,
  profileId,
  files,
  onRefresh,
  open,
  onOpen,
  active
}: {
  /** The tab is showing; it stays mounted while hidden so unsaved edits survive. */
  active: boolean
  game: string
  profileId: string
  /** Null while loading. */
  files: ConfigFile[] | null
  onRefresh(): void
  /** The file shown; null for none. */
  open: string | null
  onOpen(path: string | null): void
}): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const [query, setQuery] = useState('')
  const [loaded, setLoaded] = useState<{ path: string; text: string } | null>(null)
  const [draft, setDraft] = useState('')
  const [failure, setFailure] = useState<{ path: string; message: string } | null>(null)
  const error = failure?.path === open ? failure.message : null
  const [raw, setRaw] = useState(false)
  const [saving, setSaving] = useState(false)
  const [leaving, setLeaving] = useState<string | null | undefined>(undefined)
  const dirty = loaded !== null && draft !== loaded.text

  useEffect(() => {
    if (!open) return
    let live = true
    api.readConfig(game, profileId, open).then(
      (text) => {
        if (!live) return
        setLoaded({ path: open, text })
        setDraft(text)
      },
      (e) => {
        if (!live) return
        setLoaded(null)
        setFailure({ path: open, message: errorMessage(e) })
      }
    )
    return () => {
      live = false
    }
  }, [game, profileId, open])

  const choose = (path: string | null): void => {
    if (path === open) return
    if (dirty) setLeaving(path)
    else onOpen(path)
  }

  const save = useCallback(async (): Promise<void> => {
    if (!loaded) return
    setSaving(true)
    try {
      await api.writeConfig(game, profileId, loaded.path, draft)
      setLoaded({ path: loaded.path, text: draft })
      toast('success', `Saved ${splitConfigPath(loaded.path).name}`)
    } catch (e) {
      toast('error', errorMessage(e))
    } finally {
      setSaving(false)
    }
  }, [game, profileId, loaded, draft, toast])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const save_ = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's'
      if (save_ && active && dirty && !saving && !document.querySelector('dialog[open]')) {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, dirty, saving, save])

  const needle = query.trim().toLowerCase()
  const shown = (files ?? []).filter((f) => !needle || f.path.toLowerCase().includes(needle))
  const groups = new Map<string, ConfigFile[]>()
  for (const f of shown) {
    const { dir } = splitConfigPath(f.path)
    groups.set(dir, [...(groups.get(dir) ?? []), f])
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-72 shrink-0 flex-col border-r border-line">
        <div className="flex items-center gap-1 p-3">
          <label className="relative flex-1">
            <span className="sr-only">Filter config files</span>
            <Icon
              name="search"
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted"
            />
            <input
              type="search"
              data-find
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter files"
              className="h-8 w-full rounded-md border border-line bg-panel pr-2 pl-8 text-sm text-fg placeholder:text-muted focus:border-ember/70 focus:outline-none"
            />
          </label>
          <button
            type="button"
            title="Look for config files again"
            aria-label="Refresh config files"
            onClick={onRefresh}
            className="grid size-8 place-items-center rounded-md text-muted hover:bg-raised hover:text-fg"
          >
            <Icon name="refresh" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {files === null ? (
            <div className="flex items-center gap-2 px-2 text-sm text-muted">
              <Spinner /> Looking for config files…
            </div>
          ) : files.length === 0 ? (
            <p className="px-2 text-sm text-muted">
              No config files yet. Most mods write theirs the first time the game starts modded.
            </p>
          ) : shown.length === 0 ? (
            <p className="px-2 text-sm text-muted">No file matches “{query.trim()}”.</p>
          ) : (
            [...groups].map(([dir, list]) => (
              <div key={dir} className="mb-2">
                <p className="truncate px-2 py-1 text-[11px] font-medium text-muted" title={dir}>
                  {dir || 'Profile folder'}
                </p>
                <ul>
                  {list.map((f) => (
                    <li key={f.path}>
                      <button
                        type="button"
                        onClick={() => choose(f.path)}
                        aria-current={f.path === open ? 'true' : undefined}
                        title={f.path}
                        className={`w-full truncate rounded-md px-2 py-1.5 text-left text-sm ${
                          f.path === open
                            ? 'bg-raised text-fg'
                            : 'text-muted hover:bg-raised/60 hover:text-fg'
                        }`}
                      >
                        {splitConfigPath(f.path).name}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {!open ? (
          <div className="grid flex-1 place-items-center p-8 text-sm text-muted">
            Pick a config file to edit it.
          </div>
        ) : error ? (
          <p className="p-6 text-sm text-danger">{error}</p>
        ) : !loaded || loaded.path !== open ? (
          <div className="flex items-center gap-2 p-6 text-sm text-muted">
            <Spinner /> Loading…
          </div>
        ) : (
          <FileEditor
            path={loaded.path}
            draft={draft}
            setDraft={setDraft}
            raw={raw}
            setRaw={setRaw}
            dirty={dirty}
            saving={saving}
            onSave={() => void save()}
            onDiscard={() => setDraft(loaded.text)}
          />
        )}
      </div>

      {leaving !== undefined && (
        <ConfirmDialog
          title="Discard your changes?"
          body={`${open ? splitConfigPath(open).name : 'This file'} has changes that aren't saved.`}
          confirmLabel="Discard changes"
          onConfirm={() => onOpen(leaving)}
          onClose={() => setLeaving(undefined)}
        />
      )}
    </div>
  )
}

function FileEditor({
  path,
  draft,
  setDraft,
  raw,
  setRaw,
  dirty,
  saving,
  onSave,
  onDiscard
}: {
  path: string
  draft: string
  setDraft(text: string): void
  raw: boolean
  setRaw(raw: boolean): void
  dirty: boolean
  saving: boolean
  onSave(): void
  onDiscard(): void
}): React.JSX.Element {
  const parsed = useMemo(() => parseCfg(draft), [draft])
  // Only BepInEx-style files get a form; anything else is edited as text.
  const formable = /\.cfg$/i.test(path) && hasCfgSettings(parsed)
  const asText = raw || !formable
  const set = (entry: CfgEntry, value: string): void =>
    setDraft(setCfgValues(draft, new Map([[entry.line, value]])))
  const { name } = splitConfigPath(path)
  const plugin = parsed.header
    .find((h) => /created by plugin/i.test(h))
    ?.replace(/^.*created by plugin\s*/i, '')

  return (
    <>
      <div className="flex items-center gap-3 border-b border-line px-5 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-fg" title={path}>
            {name}
          </p>
          {plugin && <p className="truncate text-xs text-muted">{plugin}</p>}
        </div>
        {formable && (
          <div className="flex rounded-md border border-line p-0.5 text-xs" role="group">
            {(['Form', 'Text'] as const).map((label) => {
              const on = (label === 'Text') === asText
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setRaw(label === 'Text')}
                  className={`rounded px-2.5 py-1 ${on ? 'bg-raised text-fg' : 'text-muted hover:text-fg'}`}
                >
                  {label}
                </button>
              )
            })}
          </div>
        )}
        <Button variant="quiet" disabled={!dirty || saving} onClick={onDiscard}>
          Discard
        </Button>
        <Button variant="primary" disabled={!dirty || saving} onClick={onSave} title="Ctrl+S">
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {asText ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          aria-label={`Text of ${name}`}
          className="min-h-0 flex-1 resize-none bg-ink p-4 font-mono text-[13px] leading-relaxed text-fg focus:outline-none"
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {parsed.sections
            .filter((s) => s.entries.length > 0)
            .map((s) => (
              <section key={`${s.name}@${s.entries[0].line}`} className="mb-6">
                <h3 className="mb-2 text-xs font-semibold tracking-wide text-ember uppercase">
                  {s.name}
                </h3>
                <ul className="divide-y divide-line rounded-lg border border-line bg-panel">
                  {s.entries.map((e) => (
                    <SettingRow key={e.line} entry={e} onChange={(v) => set(e, v)} />
                  ))}
                </ul>
              </section>
            ))}
        </div>
      )}
    </>
  )
}

function SettingRow({
  entry,
  onChange
}: {
  entry: CfgEntry
  onChange(value: string): void
}): React.JSX.Element {
  const changed = entry.defaultValue !== null && entry.value !== entry.defaultValue
  return (
    <li className="flex items-start gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-fg">{entry.key}</p>
        {entry.description && (
          <p className="mt-0.5 text-xs whitespace-pre-line text-muted">{entry.description}</p>
        )}
        {entry.defaultValue !== null && (
          <p className="mt-1 text-[11px] text-muted">
            Default: <span className="text-fg/80">{entry.defaultValue || '(empty)'}</span>
            {changed && (
              <button
                type="button"
                onClick={() => onChange(entry.defaultValue!)}
                className="ml-2 text-ember hover:underline"
              >
                Reset
              </button>
            )}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center pt-0.5">
        <SettingControl entry={entry} onChange={onChange} />
      </div>
    </li>
  )
}

function SettingControl({
  entry,
  onChange
}: {
  entry: CfgEntry
  onChange(value: string): void
}): React.JSX.Element {
  const label = entry.key
  switch (controlFor(entry)) {
    case 'toggle': {
      const on = entry.value.toLowerCase() === 'true'
      return <Toggle checked={on} label={label} onChange={(v) => onChange(v ? 'true' : 'false')} />
    }
    case 'select': {
      const options = entry.acceptable!.includes(entry.value)
        ? entry.acceptable!
        : [entry.value, ...entry.acceptable!]
      return (
        <select
          aria-label={label}
          value={entry.value}
          onChange={(e) => onChange(e.target.value)}
          className={`${FIELD} max-w-56`}
        >
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )
    }
    case 'flags': {
      const on = new Set(splitFlags(entry.value))
      return (
        <div className="flex max-w-72 flex-wrap justify-end gap-x-3 gap-y-1" aria-label={label}>
          {entry.acceptable!.map((o) => (
            <label key={o} className="flex items-center gap-1.5 text-xs text-fg">
              <input
                type="checkbox"
                checked={on.has(o)}
                onChange={(e) => {
                  const next = entry.acceptable!.filter((x) =>
                    x === o ? e.target.checked : on.has(x)
                  )
                  onChange(next.join(', ') || 'None')
                }}
                className="size-3.5 accent-ember"
              />
              {o}
            </label>
          ))}
        </div>
      )
    }
    case 'number': {
      const r = entry.range
      return (
        <div className="flex items-center gap-2">
          {r && (
            <input
              type="range"
              aria-label={`${label} slider`}
              min={r.min}
              max={r.max}
              step={/int|byte/i.test(entry.type ?? '') ? 1 : (r.max - r.min) / 100 || 'any'}
              value={Number.isFinite(Number(entry.value)) ? Number(entry.value) : r.min}
              onChange={(e) => onChange(e.target.value)}
              className="w-32 accent-ember"
            />
          )}
          <input
            type="text"
            inputMode="decimal"
            aria-label={label}
            value={entry.value}
            onChange={(e) => onChange(e.target.value)}
            className={`${FIELD} w-24 text-right tabular-nums`}
          />
        </div>
      )
    }
    default:
      return (
        <input
          type="text"
          aria-label={label}
          value={entry.value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className={`${FIELD} w-56`}
        />
      )
  }
}
