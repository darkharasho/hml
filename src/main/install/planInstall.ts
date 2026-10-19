import type { InstallRule, ModloaderPackage } from '../../shared/types'

export interface PlannedFile {
  /** Zip entry path. */
  from: string
  /** Profile-relative destination. */
  to: string
  disableable: boolean
}

export interface InstallPlan {
  files: PlannedFile[]
}

export class UnsafeEntryError extends Error {
  constructor(entry: string) {
    super(`Unsafe zip entry: ${entry}`)
    this.name = 'UnsafeEntryError'
  }
}

interface Item {
  from: string
  segs: string[]
}

const lastSegment = (route: string): string => route.split('/').filter(Boolean).pop() ?? ''
const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

function normalize(entry: string): string[] {
  const p = entry.replace(/\\/g, '/')
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw new UnsafeEntryError(entry)
  const segs = p.split('/').filter((s) => s !== '' && s !== '.')
  if (segs.length === 0 || segs.includes('..')) throw new UnsafeEntryError(entry)
  if (segs.some(isWindowsUnsafe)) throw new UnsafeEntryError(entry)
  return segs
}

/** Names Windows can't store as written: stream/drive colons, device names, trailing `.`/space. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const isWindowsUnsafe = (seg: string): boolean =>
  seg.includes(':') || WINDOWS_DEVICE.test(seg) || /[. ]$/.test(seg)

/** Thunderstore package metadata at a zip's root; not part of the mod's files. */
const PACKAGE_METADATA = new Set([
  'manifest.json',
  'icon.png',
  'readme.md',
  'changelog.md',
  'changelog'
])

function stripWrappers(items: Item[], rules: InstallRule[], stopNames: string[] = []): Item[] {
  const routeNames = [...rules.map((r) => lastSegment(r.route)), ...stopNames]
  let cur = items
  while (cur.length > 0 && cur.every((i) => i.segs.length >= 2)) {
    const w = cur[0].segs[0]
    if (!cur.every((i) => eq(i.segs[0], w))) break
    if (eq(w, 'bepinex') || routeNames.some((n) => eq(n, w))) break
    cur = cur.map((i) => ({ ...i, segs: i.segs.slice(1) }))
  }
  return cur
}

function destination(rule: InstallRule, packageId: string, rest: string[]): string {
  const subdir = rule.trackingMethod === 'subdir' || rule.trackingMethod === 'subdir-no-flatten'
  const base = subdir ? [rule.route, packageId] : [rule.route]
  return [...base, ...rest].join('/')
}

/**
 * unreal_shimloader laid out as r2modman does: the shim `dwmapi.dll` and UE4SS's `ue4ss.dll` and
 * `UE4SS-settings.ini` at the profile root (launch copies them next to the game's exe), UE4SS's
 * bundled mods under `shimloader/mod`. Null for a package without a `UE4SS` folder.
 */
function planShimloader(items: Item[]): InstallPlan | null {
  if (!items.some((i) => i.segs.length >= 2 && eq(i.segs[0], 'ue4ss'))) return null
  const files: PlannedFile[] = []
  for (const i of items) {
    const s = i.segs
    let to: string | null = null
    if (s.length === 1 && eq(s[0], 'dwmapi.dll')) to = 'dwmapi.dll'
    else if (s.length === 2 && eq(s[0], 'ue4ss') && eq(s[1], 'ue4ss.dll')) to = 'ue4ss.dll'
    else if (s.length === 2 && eq(s[0], 'ue4ss') && eq(s[1], 'ue4ss-settings.ini'))
      to = 'UE4SS-settings.ini'
    else if (s.length >= 3 && eq(s[0], 'ue4ss') && eq(s[1], 'mods'))
      to = ['shimloader', 'mod', ...s.slice(2)].join('/')
    if (to) files.push({ from: i.from, to, disableable: false })
  }
  return { files }
}

/** The folders MelonLoader reads from the game folder (for HML, the profile). */
const MELON_DIRS = ['Mods', 'Plugins', 'UserData', 'UserLibs', 'MelonLoader']

/**
 * A mod for a MelonLoader v0.7+ game (`recursive-melonloader`), laid out as r2modman does: its
 * `UserData` folder under `UserData/<package>/`, everything else under `Mods/<package>/`, which
 * MelonLoader searches recursively. Only the `Mods` files are switched off when it is disabled.
 */
function planRecursiveMelon(items: Item[], packageId: string): InstallPlan {
  return {
    files: items.map((i) =>
      i.segs.length >= 2 && eq(i.segs[0], 'userdata')
        ? {
            from: i.from,
            to: ['UserData', packageId, ...i.segs.slice(1)].join('/'),
            disableable: false
          }
        : { from: i.from, to: ['Mods', packageId, ...i.segs].join('/'), disableable: true }
    )
  }
}

export function planInstall(
  entries: string[],
  opts: {
    packageId: string
    rules: InstallRule[]
    loaderPackage?: ModloaderPackage
    /** The game's loader; only `recursive-melonloader` changes how mods are laid out. */
    loader?: string
  }
): InstallPlan {
  const { packageId, rules, loaderPackage } = opts
  const items = entries.map((from) => ({ from, segs: normalize(from) }))
  const melon = opts.loader === 'recursive-melonloader'
  const stopNames = loaderPackage?.rootFolder ? [loaderPackage.rootFolder] : []
  const stripped = stripWrappers(items, rules, melon ? [...stopNames, ...MELON_DIRS] : stopNames)

  if (loaderPackage?.loader === 'shimloader') {
    const shim = planShimloader(stripped)
    if (shim) return shim
  }

  if (loaderPackage) {
    // An empty root folder means the zip already has the game-folder layout: keep paths as they are.
    const root = loaderPackage.rootFolder
    const files: PlannedFile[] = []
    for (const i of stripped) {
      if (root === '') {
        if (i.segs.length === 1 && PACKAGE_METADATA.has(i.segs[0].toLowerCase())) continue
        files.push({ from: i.from, to: i.segs.join('/'), disableable: false })
      } else if (i.segs.length >= 2 && eq(i.segs[0], root)) {
        files.push({ from: i.from, to: i.segs.slice(1).join('/'), disableable: false })
      }
    }
    return { files }
  }

  if (melon) return planRecursiveMelon(stripped, packageId)

  const defaultRule = rules.find((r) => r.isDefaultLocation)
  if (!defaultRule) throw new Error('No default install rule (isDefaultLocation) defined')

  const files: PlannedFile[] = []
  for (const i of stripped) {
    let segs = i.segs
    if (segs.length > 1 && eq(segs[0], 'bepinex')) segs = segs.slice(1)

    let rule: InstallRule | undefined
    let rest = segs
    if (segs.length > 1) {
      rule = rules.find((r) => eq(lastSegment(r.route), segs[0]))
      if (rule) rest = segs.slice(1)
    } else {
      const name = segs[0].toLowerCase()
      let best = 0
      for (const r of rules) {
        for (const ext of r.defaultFileExtensions) {
          if (ext.length > best && name.endsWith(ext.toLowerCase())) {
            best = ext.length
            rule = r
          }
        }
      }
    }
    rule ??= defaultRule
    files.push({
      from: i.from,
      to: destination(rule, packageId, rest),
      disableable: rule.trackingMethod !== 'none'
    })
  }
  return { files }
}

const LAYOUT_DIRS = new Set(
  'data bepinex mods plugins bin binaries content scripts textures meshes sound music interface skse f4se root'.split(
    ' '
  )
)

/**
 * Deploy games mirror the game folder (or its `root` folder): install as-is, minus one sole
 * wrapping folder unless it is a known game-layout directory. With a root, a sole top-level
 * folder named like the root is stripped too, so `Data/x.esp` lands in `<root>/x.esp`.
 */
export function planDeploy(entries: string[], opts: { root?: string } = {}): InstallPlan {
  const items = entries.map((from) => ({ from, segs: normalize(from) }))
  const soleTop = (list: Item[]): string | null =>
    list.length > 0 &&
    list.every((i) => i.segs.length >= 2) &&
    list.every((i) => eq(i.segs[0], list[0].segs[0]))
      ? list[0].segs[0]
      : null
  let cur: Item[] = items
  const wrapper = soleTop(cur)
  if (wrapper !== null && !LAYOUT_DIRS.has(wrapper.toLowerCase())) {
    cur = cur.map((i) => ({ ...i, segs: i.segs.slice(1) }))
  }
  const top = soleTop(cur)
  if (opts.root && top !== null && eq(top, opts.root)) {
    cur = cur.map((i) => ({ ...i, segs: i.segs.slice(1) }))
  }
  return {
    files: cur.map((i) => ({ from: i.from, to: i.segs.join('/'), disableable: true }))
  }
}
