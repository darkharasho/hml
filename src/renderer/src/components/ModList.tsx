import { useEffect, useRef, useState, type DragEvent } from 'react'
import type {
  ConfigFile,
  GhUpdate,
  InstalledMod,
  ModSource,
  ModUpdate,
  NxMod,
  NxUpdate,
  TsPackage
} from '../../../shared/types'
import { api, errorMessage, pathForFile } from '../api'
import { sourcesFor } from '../customView'
import {
  canFollowPrereleases,
  ghSubline,
  githubRepoUrl,
  isPrereleaseInstall,
  UPDATE_MODES,
  updateModeLabel
} from '../ghView'
import { nexusModUrl } from '../nxView'
import { useCurrentProfile, useStore } from '../store'
import { LOCAL_WONT_SYNC, SYNC_LOCKED_NOTE, isFollower, isOwner } from '../syncView'
import { initials, UNSUPPORTED_LOADER } from '../tsView'
import { useFallbackSrc } from '../useFallbackSrc'
import { Browse } from './Browse'
import { GithubDialog } from './GithubDialog'
import { NexusDetail } from './NexusDetail'
import { PackageDetail, ProgressLine } from './PackageDetail'
import { Button, Icon, Menu, Toggle, type MenuItem } from './ui'
import { DisableDialog, UninstallDialog } from './ModDepsDialogs'
import { GhVersionDialog } from './GhVersionDialog'
import { ConfigEditor } from './ConfigEditor'
import { LogViewer } from './LogViewer'
import { configsForMod } from '../configView'
import { dependentsOf, orphanedBy } from '../../../shared/modDeps'

/** Thunderstore is where most mods come from, so only the other sources get a badge. */
const SOURCE_BADGE: Record<
  Exclude<ModSource['kind'], 'thunderstore'>,
  { label: string; className: string }
> = {
  github: { label: 'GitHub', className: 'text-fg bg-fg/10' },
  nexus: { label: 'Nexus', className: 'text-warn bg-warn/10' },
  local: { label: 'Local file', className: 'text-muted bg-muted/10' }
}

const hasFiles = (e: DragEvent): boolean => e.dataTransfer.types.includes('Files')

const NO_ICONS: string[] = []

type Filter = 'all' | 'updates' | 'disabled'
type Detail = { kind: 'ts'; pkg: TsPackage } | { kind: 'nx'; domain: string; mod: NxMod }
const NO_ICON_MAP: Record<string, string[]> = {}

/**
 * Icon URLs for each installed mod, fetched again when the mod set or a version changes. Empty
 * until main answers (rows show their letter tile meanwhile) or when the lookup fails.
 */
function useModIcons(
  game: string | undefined,
  profileId: string | undefined,
  mods: InstalledMod[] | undefined
): Record<string, string[]> {
  const scope = `${game}/${profileId}`
  const key = `${scope}/${(mods ?? []).map((m) => `${m.id}@${m.version}`).join('|')}`
  const [icons, setIcons] = useState<{ scope: string; urls: Record<string, string[]> }>({
    scope: '',
    urls: {}
  })
  useEffect(() => {
    if (!game || !profileId) return
    let live = true
    api.getModIcons(game, profileId).then(
      (urls) => live && setIcons({ scope, urls }),
      () => undefined
    )
    return () => {
      live = false
    }
    // key covers game, profileId (scope) and the mods.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  // Within one profile the previous answer stands in until the new one arrives (or when a lookup
  // fails), so installing a mod doesn't make every row flash back to its letter tile. Another
  // game's or profile's icons never show.
  return icons.scope === scope ? icons.urls : NO_ICON_MAP
}

export function ModList(): React.JSX.Element | null {
  const profile = useCurrentProfile()
  const busy = useStore((s) => s.busy)
  const installFromFile = useStore((s) => s.installFromFile)
  const installFromPaths = useStore((s) => s.installFromPaths)
  const toast = useStore((s) => s.toast)
  const openProfileFolder = useStore((s) => s.openProfileFolder)
  const game = useStore((s) => s.currentGame)
  const currentDomain = useStore((s) => s.currentDomain)
  const updates = useStore((s) => s.updates)
  const ghUpdates = useStore((s) => s.ghUpdates)
  const nxUpdates = useStore((s) => s.nxUpdates)
  const updateAll = useStore((s) => s.updateAll)
  const updatingAny = useStore(
    (s) => s.tsInstalling.length > 0 || s.ghUpdating.length > 0 || s.nxInstalling.length > 0
  )
  const [githubOpen, setGithubOpen] = useState(false)
  const [tab, setTab] = useState<'installed' | 'online' | 'config' | 'log'>('installed')
  const gameLabel = game?.label
  const profileId = profile?.id
  const modCount = profile?.mods.length ?? 0
  // Both are kept per profile: another profile's config files and open file aren't this one's.
  const profileKey = `${gameLabel}/${profileId}`
  const [configList, setConfigList] = useState<{ key: string; files: ConfigFile[] } | null>(null)
  const [configPick, setConfigPick] = useState<{ key: string; path: string | null } | null>(null)
  const configFiles = configList?.key === profileKey ? configList.files : null
  const configOpen = configPick?.key === profileKey ? configPick.path : null
  const setConfigOpen = (path: string | null): void => setConfigPick({ key: profileKey, path })
  const [configOpened, setConfigOpened] = useState(false)
  const [configNonce, setConfigNonce] = useState(0)
  // Mods write their configs on first run and installs add some, so look again on each change.
  useEffect(() => {
    if (!gameLabel || !profileId) return
    let live = true
    const key = `${gameLabel}/${profileId}`
    api.listConfigs(gameLabel, profileId).then(
      (files) => live && setConfigList({ key, files }),
      () => live && setConfigList({ key, files: [] })
    )
    return () => {
      live = false
    }
  }, [gameLabel, profileId, modCount, configNonce])
  // Browse mounts on first visit and then stays mounted, so search and filters survive tab switches.
  const [onlineOpened, setOnlineOpened] = useState(false)
  const [dragging, setDragging] = useState(false)
  // dragenter/dragleave fire for every child element; count depth to know when we truly left.
  const depth = useRef(0)
  const icons = useModIcons(game?.label, profile?.id, profile?.mods)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [detail, setDetail] = useState<Detail | null>(null)

  if (!profile || !game) return null
  // A followed profile's mods change only through its sync code; configs stay editable.
  const locked = isFollower(profile)
  const owner = isOwner(profile)
  const updateById = new Map(updates.map((u) => [u.modId, u]))
  const ghUpdateById = new Map(ghUpdates.map((u) => [u.modId, u]))
  const nxUpdateById = new Map(nxUpdates.map((u) => [u.modId, u]))
  const updateCount = updates.length + ghUpdates.length + nxUpdates.length
  const openGithub = (): void => setGithubOpen(true)
  const { online, githubPrimary } = sourcesFor(game, currentDomain)
  const hasOnline = online.length > 0
  // The domain can change while the Online tab is open; fall back to Installed if it vanishes.
  // Only loaders HML knows the log of get a Log tab.
  const hasLog = [
    'bepinex',
    'shimloader',
    'melonloader',
    'recursive-melonloader',
    'lovely',
    'return-of-modding'
  ].includes(game.loader)
  const activeTab =
    (tab === 'online' && !hasOnline) || (tab === 'log' && !hasLog) ? 'installed' : tab
  const openConfig = (path: string | null): void => {
    setTab('config')
    setConfigOpened(true)
    setConfigOpen(path)
  }
  const custom = !!game.custom
  const fileButton = (
    <Button
      variant={githubPrimary ? 'quiet' : 'ghost'}
      disabled={busy || locked}
      onClick={() => void installFromFile()}
    >
      <Icon name="upload" />
      Install from file
    </Button>
  )
  const githubButton = (
    <Button
      variant={githubPrimary ? 'primary' : 'ghost'}
      disabled={busy || locked || !game.supported}
      title={locked ? SYNC_LOCKED_NOTE : game.supported ? undefined : UNSUPPORTED_LOADER}
      onClick={openGithub}
    >
      <Icon name="github" />
      Add from GitHub
    </Button>
  )
  const mods = [...profile.mods].sort((a, b) => a.name.localeCompare(b.name))
  const enabledCount = mods.filter((m) => m.enabled).length
  const hasUpdate = (m: InstalledMod): boolean =>
    updateById.has(m.id) || ghUpdateById.has(m.id) || nxUpdateById.has(m.id)
  const disabledCount = mods.length - enabledCount
  // A quick filter whose count drops to zero (the last update installed) shows everything again.
  const activeFilter =
    (filter === 'updates' && updateCount === 0) || (filter === 'disabled' && disabledCount === 0)
      ? 'all'
      : filter
  const needle = query.trim().toLowerCase()
  const shown = mods.filter(
    (m) =>
      (activeFilter === 'all' || (activeFilter === 'updates' ? hasUpdate(m) : !m.enabled)) &&
      (!needle || m.name.toLowerCase().includes(needle) || m.id.toLowerCase().includes(needle))
  )
  const browseOnline = (): void => {
    setTab('online')
    setOnlineOpened(true)
  }

  async function openDetail(mod: InstalledMod): Promise<void> {
    const source = mod.source
    if (!game) return
    try {
      if (source.kind === 'thunderstore') {
        const pkg = await api.tsGetPackage(game.label, source.fullName)
        if (pkg) setDetail({ kind: 'ts', pkg })
        else toast('error', `${mod.name} is no longer listed on Thunderstore.`)
      } else if (source.kind === 'nexus') {
        const d = await api.nxGetMod(game.label, source.modId)
        setDetail({ kind: 'nx', domain: d.domain, mod: d.mod })
      }
    } catch (e) {
      toast('error', errorMessage(e))
    }
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault()
    depth.current = 0
    setDragging(false)
    const paths: string[] = []
    let unreadable = false
    for (const f of Array.from(e.dataTransfer.files)) {
      try {
        const path = pathForFile(f)
        if (path) paths.push(path)
      } catch {
        unreadable = true
      }
    }
    if (locked) return
    if (unreadable) toast('error', "Couldn't read a dropped file. Use Install from file instead.")
    void installFromPaths(paths)
  }

  return (
    <section
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={(e) => {
        if (!hasFiles(e) || locked) return
        depth.current += 1
        setDragging(true)
      }}
      onDragOver={(e) => {
        if (!hasFiles(e) || locked) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <div className="flex items-end justify-between gap-4 border-b border-line px-6">
        <div role="tablist" aria-label="Profile views" className="flex gap-6">
          <TabButton selected={activeTab === 'installed'} onSelect={() => setTab('installed')}>
            Installed
            <span className="ml-2 text-xs font-normal text-muted tabular-nums">{mods.length}</span>
          </TabButton>
          {hasOnline && (
            <TabButton selected={activeTab === 'online'} onSelect={browseOnline}>
              Online
            </TabButton>
          )}
          <TabButton
            selected={activeTab === 'config'}
            onSelect={() => {
              setTab('config')
              setConfigOpened(true)
              setConfigNonce((n) => n + 1)
            }}
          >
            Config
          </TabButton>
          {hasLog && (
            <TabButton selected={activeTab === 'log'} onSelect={() => setTab('log')}>
              Log
            </TabButton>
          )}
        </div>
        <div className="flex h-11 items-center gap-2 pb-2">
          {activeTab === 'installed' && (
            <>
              {/* Icon only in a narrow window, so the install buttons still fit beside the tabs. */}
              <Button variant="quiet" title="Open folder" onClick={() => void openProfileFolder()}>
                <Icon name="folder" />
                <span className="max-[1000px]:sr-only">Open folder</span>
              </Button>
              {githubPrimary ? (
                <>
                  {githubButton}
                  {fileButton}
                </>
              ) : (
                <>
                  {fileButton}
                  {githubButton}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {locked && (
        <p
          role="note"
          className="mx-6 mt-3 flex items-center gap-2 rounded-md border border-line bg-panel px-3 py-2 text-sm text-muted"
        >
          <Icon name="refresh" className="size-4 shrink-0 text-teal" />
          {SYNC_LOCKED_NOTE}
        </p>
      )}

      {onlineOpened && (
        <div className={activeTab === 'online' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
          <Browse key={game.label} game={game.label} />
        </div>
      )}
      {configOpened && (
        <div className={activeTab === 'config' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
          <ConfigEditor
            key={`${game.label}/${profile.id}`}
            active={activeTab === 'config'}
            game={game.label}
            profileId={profile.id}
            files={configFiles}
            onRefresh={() => setConfigNonce((n) => n + 1)}
            open={configOpen}
            onOpen={setConfigOpen}
          />
        </div>
      )}
      {activeTab === 'log' && (
        <LogViewer game={game.label} profileId={profile.id} mods={profile.mods} active />
      )}
      {activeTab !== 'installed' ? null : mods.length === 0 ? (
        <EmptyState
          onPick={() => void installFromFile()}
          onGithub={openGithub}
          onBrowse={hasOnline ? browseOnline : undefined}
          supported={game.supported}
          busy={busy || locked}
          locked={locked}
          custom={custom}
          githubPrimary={githubPrimary}
        />
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="flex min-h-9 flex-wrap items-center gap-2 px-2 pb-2">
            <label className="relative w-64">
              <span className="sr-only">Filter installed mods</span>
              <Icon
                name="search"
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted"
              />
              <input
                type="search"
                data-find
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter mods"
                className="h-8 w-full rounded-md border border-line bg-panel pr-2 pl-8 text-sm text-fg placeholder:text-muted focus:border-ember/70 focus:outline-none"
              />
            </label>
            {updateCount > 0 && (
              <FilterChip
                selected={activeFilter === 'updates'}
                onToggle={() => setFilter(activeFilter === 'updates' ? 'all' : 'updates')}
              >
                Updates {updateCount}
              </FilterChip>
            )}
            {disabledCount > 0 && (
              <FilterChip
                selected={activeFilter === 'disabled'}
                onToggle={() => setFilter(activeFilter === 'disabled' ? 'all' : 'disabled')}
              >
                Disabled {disabledCount}
              </FilterChip>
            )}
            <p className="ml-auto text-xs text-muted tabular-nums">
              {enabledCount} of {mods.length} enabled
            </p>
            {updateCount > 0 && (
              <Button
                variant="primary"
                disabled={!game.supported || updatingAny || locked}
                title={game.supported ? undefined : UNSUPPORTED_LOADER}
                onClick={() => void updateAll()}
              >
                <Icon name="download" />
                Update all ({updateCount})
              </Button>
            )}
          </div>
          {shown.length === 0 ? (
            <div className="px-2 py-10 text-center text-sm text-muted">
              <p>{needle ? `No mods match “${query.trim()}”.` : 'No mods match this filter.'}</p>
              <Button
                variant="ghost"
                className="mt-3"
                onClick={() => {
                  setQuery('')
                  setFilter('all')
                }}
              >
                Show all mods
              </Button>
            </div>
          ) : (
            <ul className="flex flex-col">
              {shown.map((m) => (
                <ModRow
                  key={m.id}
                  mod={m}
                  icons={icons[m.id] ?? NO_ICONS}
                  update={updateById.get(m.id)}
                  ghUpdate={ghUpdateById.get(m.id)}
                  nxUpdate={nxUpdateById.get(m.id)}
                  supported={game.supported}
                  locked={locked}
                  wontSync={owner && m.source.kind === 'local'}
                  onOpen={
                    m.source.kind === 'thunderstore' || m.source.kind === 'nexus'
                      ? () => void openDetail(m)
                      : undefined
                  }
                  config={configFiles ? configsForMod(m, configFiles)[0]?.path : undefined}
                  onEditConfig={openConfig}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {detail?.kind === 'ts' && (
        <PackageDetail key={detail.pkg.fullName} pkg={detail.pkg} onClose={() => setDetail(null)} />
      )}
      {detail?.kind === 'nx' && (
        <NexusDetail
          key={detail.mod.modId}
          game={game.label}
          domain={detail.domain}
          mod={detail.mod}
          onClose={() => setDetail(null)}
        />
      )}

      {githubOpen && <GithubDialog onClose={() => setGithubOpen(false)} />}

      {dragging && (
        <div className="pointer-events-none absolute inset-3 grid place-items-center rounded-xl border-2 border-dashed border-ember bg-ink/85">
          <div className="text-center">
            <Icon name="upload" className="mx-auto size-8 text-ember" />
            <p className="mt-2 text-base font-semibold">Drop to install into {profile.name}</p>
            <p className="text-sm text-muted">Mod .zip files only</p>
          </div>
        </div>
      )}
    </section>
  )
}

function FilterChip({
  selected,
  onToggle,
  children
}: {
  selected: boolean
  onToggle(): void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onToggle}
      className={`h-8 rounded-md border px-2.5 text-xs font-medium tabular-nums transition-colors ${
        selected
          ? 'border-ember/60 bg-ember/15 text-fg'
          : 'border-line text-muted hover:border-[#3a5664] hover:text-fg'
      }`}
    >
      {children}
    </button>
  )
}

function TabButton({
  selected,
  onSelect,
  children
}: {
  selected: boolean
  onSelect(): void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={`-mb-px border-b-2 pt-4 pb-2.5 text-sm font-semibold transition-colors ${
        selected ? 'border-ember text-fg' : 'border-transparent text-muted hover:text-fg'
      }`}
    >
      {children}
    </button>
  )
}

/** A mod's icon, trying each URL in turn, with a letter tile when none loads. */
function ModIcon({ name, urls }: { name: string; urls: string[] }): React.JSX.Element {
  const { src, onError } = useFallbackSrc(urls)
  const shape = 'size-12 shrink-0 overflow-hidden rounded-md bg-raised'
  if (src) {
    return (
      <img
        key={src}
        src={src}
        alt=""
        loading="lazy"
        draggable={false}
        onError={onError}
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

function ModRow({
  mod,
  icons,
  update,
  ghUpdate,
  nxUpdate,
  supported,
  locked,
  wontSync,
  onOpen,
  config,
  onEditConfig
}: {
  mod: InstalledMod
  /** The profile follows a sync code: its mods can't be changed here. */
  locked: boolean
  /** A local mod on a profile that publishes a sync code. */
  wontSync: boolean
  icons: string[]
  /** The mod's config file, when one is found. */
  config?: string
  onEditConfig(path: string): void
  update?: ModUpdate
  ghUpdate?: GhUpdate
  nxUpdate?: NxUpdate
  supported: boolean
  /** Opens the mod's details; missing for sources that have no details view. */
  onOpen?(): void
}): React.JSX.Element {
  const setModEnabled = useStore((s) => s.setModEnabled)
  const uninstallMod = useStore((s) => s.uninstallMod)
  const tsUpdate = useStore((s) => s.tsUpdate)
  const runGhUpdate = useStore((s) => s.ghUpdate)
  const runNxUpdate = useStore((s) => s.nxUpdate)
  const setUpdateMode = useStore((s) => s.ghSetUpdateMode)
  const setPrereleases = useStore((s) => s.ghSetPrereleases)
  const toast = useStore((s) => s.toast)
  const game = useStore((s) => s.currentGame?.label ?? '')
  const updating = useStore((s) =>
    mod.source.kind === 'thunderstore'
      ? s.tsInstalling.includes(mod.source.fullName)
      : mod.source.kind === 'nexus'
        ? s.nxInstalling.includes(mod.source.modId)
        : s.ghUpdating.includes(mod.id)
  )
  const setModHeld = useStore((s) => s.setModHeld)
  const loadModDeps = useStore((s) => s.loadModDeps)
  const profileMods = useCurrentProfile()?.mods ?? []
  const [dialog, setDialog] = useState<
    | { kind: 'disable'; dependents: InstalledMod[] }
    | { kind: 'uninstall'; dependents: InstalledMod[]; orphans: InstalledMod[] }
    | { kind: 'version' }
    | null
  >(null)
  const byIds = (ids: string[]): InstalledMod[] => profileMods.filter((m) => ids.includes(m.id))

  async function toggle(enabled: boolean): Promise<void> {
    if (enabled) return setModEnabled(mod.id, true)
    const graph = await loadModDeps()
    const dependents = graph ? byIds(dependentsOf(graph, profileMods, mod.id)) : []
    if (dependents.length === 0) return setModEnabled(mod.id, false)
    setDialog({ kind: 'disable', dependents })
  }

  async function askUninstall(): Promise<void> {
    const graph = await loadModDeps()
    setDialog({
      kind: 'uninstall',
      dependents: graph ? byIds(dependentsOf(graph, profileMods, mod.id)) : [],
      orphans: graph ? byIds(orphanedBy(graph, profileMods, mod.id)) : []
    })
  }
  const badge = mod.source.kind === 'thunderstore' ? null : SOURCE_BADGE[mod.source.kind]
  const canToggle = mod.disableable.length > 0
  const source = mod.source
  const latest = update?.latest ?? ghUpdate?.latest ?? nxUpdate?.latest
  const runUpdate = (): void =>
    void (update
      ? tsUpdate([update])
      : ghUpdate
        ? runGhUpdate([ghUpdate])
        : nxUpdate && runNxUpdate([nxUpdate]))

  const uninstall: MenuItem = {
    label: 'Uninstall…',
    danger: true,
    disabled: locked,
    onSelect: () => void askUninstall()
  }
  const hold: MenuItem = {
    label: 'Hold at this version',
    checked: mod.held === true,
    toggle: true,
    divider: true,
    disabled: locked,
    onSelect: () => void setModHeld(mod.id, mod.held !== true)
  }
  let menu: MenuItem[] = [uninstall]
  if (source.kind === 'thunderstore') {
    menu = [
      ...(onOpen ? [{ label: 'Details…', onSelect: onOpen }] : []),
      {
        label: 'Open on Thunderstore',
        onSelect: () => void openOnThunderstore()
      },
      hold,
      { ...uninstall, divider: true }
    ]
  } else if (source.kind === 'github') {
    const mode = mod.github?.updateMode ?? 'auto'
    menu = [
      {
        label: 'Open on GitHub',
        onSelect: () =>
          void api.openExternal(githubRepoUrl(source)).catch((e) => toast('error', errorMessage(e)))
      },
      {
        label: 'Change version…',
        disabled: locked,
        onSelect: () => setDialog({ kind: 'version' })
      },
      ...UPDATE_MODES.map((m, i): MenuItem => ({
        label: updateModeLabel(m),
        checked: m === mode,
        divider: i === 0,
        disabled: locked,
        onSelect: () => void (m !== mode && setUpdateMode(mod.id, m))
      })),
      ...(canFollowPrereleases(mod)
        ? [
            {
              label: 'Include prereleases',
              checked: mod.github?.prereleases === true,
              toggle: true,
              divider: true,
              disabled: locked,
              onSelect: () => void setPrereleases(mod.id, mod.github?.prereleases !== true)
            }
          ]
        : []),
      { ...uninstall, divider: true }
    ]
  } else if (source.kind === 'nexus') {
    menu = [
      {
        label: 'Open on Nexus Mods',
        onSelect: () =>
          void api
            .openExternal(nexusModUrl(source.domain, source.modId))
            .catch((e) => toast('error', errorMessage(e)))
      },
      hold,
      { ...uninstall, divider: true }
    ]
  }
  if (source.kind === 'nexus' && onOpen) menu = [{ label: 'Details…', onSelect: onOpen }, ...menu]
  if (config) {
    const at = onOpen ? 1 : 0
    menu = [
      ...menu.slice(0, at),
      { label: 'Edit config…', onSelect: () => onEditConfig(config) },
      ...menu.slice(at)
    ]
  }

  async function openOnThunderstore(): Promise<void> {
    if (source.kind !== 'thunderstore') return
    try {
      const pkg = await api.tsGetPackage(game, source.fullName)
      if (!pkg) throw new Error(`${mod.name} is no longer listed on Thunderstore.`)
      await api.openExternal(pkg.packageUrl)
    } catch (e) {
      toast('error', errorMessage(e))
    }
  }

  const summary = (
    <>
      <div className={mod.enabled ? '' : 'opacity-55'}>
        <ModIcon name={mod.name} urls={icons} />
      </div>
      <div className={`min-w-0 flex-1 ${mod.enabled ? '' : 'opacity-55'}`}>
        <div className="flex items-baseline gap-2">
          <span className="truncate font-medium text-fg">{mod.name}</span>
          <span className="shrink-0 text-xs text-muted tabular-nums">{mod.version}</span>
          {isPrereleaseInstall(mod) && (
            <span
              className="shrink-0 self-center rounded bg-warn/10 px-1.5 py-px text-[10px] font-medium text-warn"
              title="The installed release is a pre-release"
            >
              Pre-release
            </span>
          )}
          {mod.held && (
            <span
              className="shrink-0 self-center rounded bg-teal/10 px-1.5 py-px text-[10px] font-medium text-teal"
              title="Held at this version: HML doesn't offer updates for it"
            >
              Held
            </span>
          )}
        </div>
        {updating ? (
          <ProgressLine className="mt-0.5" />
        ) : source.kind === 'local' ? (
          <p className="truncate text-xs text-muted">{source.fileName}</p>
        ) : (
          source.kind === 'github' && (
            <p className="truncate text-xs text-muted">
              {ghSubline(source, mod.github?.updateMode ?? 'auto')}
            </p>
          )
        )}
      </div>
    </>
  )

  return (
    <li className="group flex items-center gap-4 rounded-lg px-2 py-2.5 hover:bg-panel">
      {canToggle ? (
        <Toggle
          checked={mod.enabled}
          disabled={locked}
          title={locked ? SYNC_LOCKED_NOTE : undefined}
          label={`${mod.enabled ? 'Disable' : 'Enable'} ${mod.name}`}
          onChange={(v) => void toggle(v)}
        />
      ) : (
        <span
          className="w-9 shrink-0 text-center text-[10px] leading-tight font-medium text-muted"
          title="This mod has no files that can be switched off"
        >
          Always on
        </span>
      )}
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          title={`Details for ${mod.name}`}
          className="-my-1 flex min-w-0 flex-1 items-center gap-4 rounded-md py-1 text-left"
        >
          {summary}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-4">{summary}</div>
      )}
      {latest && (
        <Button
          className="h-7 px-2.5 text-xs"
          disabled={!supported || updating || locked}
          title={locked ? SYNC_LOCKED_NOTE : supported ? undefined : UNSUPPORTED_LOADER}
          onClick={runUpdate}
        >
          {updating ? 'Updating…' : `Update to ${latest}`}
        </Button>
      )}
      {wontSync && (
        <span
          className="shrink-0 rounded bg-warn/10 px-1.5 py-0.5 text-[11px] font-medium text-warn"
          title="Local files can't travel with a sync code, so friends won't get this mod"
        >
          {LOCAL_WONT_SYNC}
        </span>
      )}
      {badge && (
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${badge.className}`}
        >
          {badge.label}
        </span>
      )}
      <Menu label={`Actions for ${mod.name}`} items={menu} />
      {dialog?.kind === 'disable' && (
        <DisableDialog
          mod={mod}
          dependents={dialog.dependents}
          onDisable={(also) =>
            void setModEnabled(
              mod.id,
              false,
              also.map((m) => m.id)
            )
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'version' && <GhVersionDialog mod={mod} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'uninstall' && (
        <UninstallDialog
          mod={mod}
          dependents={dialog.dependents}
          orphans={dialog.orphans}
          onUninstall={(also) => void uninstallMod(mod, also)}
          onClose={() => setDialog(null)}
        />
      )}
    </li>
  )
}

function EmptyState({
  onPick,
  onGithub,
  onBrowse,
  supported,
  busy,
  locked,
  custom,
  githubPrimary
}: {
  onPick(): void
  onGithub(): void
  /** Opens the Online tab; missing when the game has no online catalog. */
  onBrowse?(): void
  supported: boolean
  busy: boolean
  locked: boolean
  custom: boolean
  githubPrimary: boolean
}): React.JSX.Element {
  const githubButton = (
    <Button
      variant={githubPrimary && !onBrowse ? 'primary' : 'ghost'}
      disabled={busy || !supported}
      title={supported ? undefined : UNSUPPORTED_LOADER}
      onClick={onGithub}
    >
      <Icon name="github" />
      Add from GitHub
    </Button>
  )
  // Browsing is the main way in when the game has a catalog; otherwise GitHub or a zip.
  const fileButton = (
    <Button
      variant={onBrowse || githubPrimary ? 'quiet' : custom ? 'ghost' : 'primary'}
      disabled={locked}
      onClick={onPick}
    >
      Install from file
    </Button>
  )
  return (
    <div className="grid flex-1 place-items-center p-8">
      <div className="max-w-lg rounded-xl border border-dashed border-line px-8 py-10 text-center">
        <Icon name="upload" className="mx-auto size-7 text-muted" />
        <p className="mt-3 font-semibold">No mods in this profile yet</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
          {onBrowse
            ? 'Find mods in the Online tab, add one from its GitHub repository, or drop a .zip here.'
            : custom
              ? 'Add a mod from its GitHub repository, or drop a .zip here.'
              : 'Drop mod .zip files here, pick them from disk, or add a mod from its GitHub repository.'}
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {onBrowse && (
            <Button variant="primary" onClick={onBrowse}>
              <Icon name="search" />
              Browse mods
            </Button>
          )}
          {githubPrimary || onBrowse ? (
            <>
              {githubButton}
              {fileButton}
            </>
          ) : (
            <>
              {fileButton}
              {githubButton}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
