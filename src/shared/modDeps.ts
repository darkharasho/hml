import type { InstalledMod } from './types'

/** How a profile's installed mods depend on each other, by mod id. */
export interface ModDeps {
  /** Each mod's direct dependencies that are installed. Mods without known ones are absent. */
  deps: Record<string, string[]>
  /** Installed mods that are the game's loader: never offered for removal. */
  loaders: string[]
}

/** `start` and every installed mod reachable from it through `next`, without `start`. */
function reach(start: string, next: (id: string) => string[]): Set<string> {
  const seen = new Set<string>([start])
  const stack = [start]
  while (stack.length > 0) {
    for (const n of next(stack.pop()!)) {
      if (seen.has(n)) continue
      seen.add(n)
      stack.push(n)
    }
  }
  seen.delete(start)
  return seen
}

function installedDeps(graph: ModDeps, mods: InstalledMod[]): (id: string) => string[] {
  const ids = new Set(mods.map((m) => m.id))
  return (id) => (graph.deps[id] ?? []).filter((d) => ids.has(d))
}

/** Enabled mods that need `id`, directly or through other mods. */
export function dependentsOf(graph: ModDeps, mods: InstalledMod[], id: string): string[] {
  const depsOf = installedDeps(graph, mods)
  const needers = new Map<string, string[]>()
  for (const m of mods) {
    for (const d of depsOf(m.id)) needers.set(d, [...(needers.get(d) ?? []), m.id])
  }
  const enabled = new Set(mods.filter((m) => m.enabled).map((m) => m.id))
  return [...reach(id, (n) => needers.get(n) ?? [])].filter((n) => enabled.has(n))
}

/** Disabled mods that `id` needs, directly or through other mods. */
export function disabledDependencies(graph: ModDeps, mods: InstalledMod[], id: string): string[] {
  const disabled = new Set(mods.filter((m) => !m.enabled).map((m) => m.id))
  return [...reach(id, installedDeps(graph, mods))].filter((n) => disabled.has(n))
}

/**
 * Mods that only `id` needs: its dependencies, direct or not, that no other installed mod
 * (enabled or not) still needs once `id` and they are gone. The loader is never one.
 */
export function orphanedBy(graph: ModDeps, mods: InstalledMod[], id: string): string[] {
  const depsOf = installedDeps(graph, mods)
  const candidates = reach(id, depsOf)
  const needed = new Set<string>()
  for (const m of mods) {
    if (m.id === id || candidates.has(m.id)) continue
    for (const n of reach(m.id, depsOf)) needed.add(n)
  }
  const loaders = new Set(graph.loaders)
  return [...candidates].filter((n) => !needed.has(n) && !loaders.has(n))
}
