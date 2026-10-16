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
  return segs
}

/** Thunderstore package metadata at a zip's root; not part of the mod's files. */
const PACKAGE_METADATA = new Set([
  'manifest.json',
  'icon.png',
  'readme.md',
  'changelog.md',
  'changelog'
])

function stripWrappers(items: Item[], rules: InstallRule[], stopName?: string): Item[] {
  const routeNames = rules.map((r) => lastSegment(r.route))
  let cur = items
  while (cur.length > 0 && cur.every((i) => i.segs.length >= 2)) {
    const w = cur[0].segs[0]
    if (!cur.every((i) => eq(i.segs[0], w))) break
    if (stopName && eq(w, stopName)) break
    if (eq(w, 'bepinex') || routeNames.some((n) => eq(n, w))) break
    cur = cur.map((i) => ({ ...i, segs: i.segs.slice(1) }))
  }
  return cur
}

function destination(rule: InstallRule, packageId: string, rest: string[]): string {
  const base = rule.trackingMethod === 'subdir' ? [rule.route, packageId] : [rule.route]
  return [...base, ...rest].join('/')
}

export function planInstall(
  entries: string[],
  opts: { packageId: string; rules: InstallRule[]; loaderPackage?: ModloaderPackage }
): InstallPlan {
  const { packageId, rules, loaderPackage } = opts
  const items = entries.map((from) => ({ from, segs: normalize(from) }))
  const stripped = stripWrappers(items, rules, loaderPackage?.rootFolder)

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
