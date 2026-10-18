import type { InstalledMod, UpdateSummary } from '../../shared/types'

/** One source's update check of a profile: the ids of mods with an update, and to what. */
export type SourceCheck = (
  game: string,
  profileId: string
) => Promise<{ modId: string; latest: string }[]>

export interface BackgroundCheckDeps {
  /** Games HML keeps profiles for, with their display names. */
  games(): Promise<{ label: string; displayName: string }[]>
  profiles(game: string): Promise<{ id: string; name: string; mods: InstalledMod[] }[]>
  /** Checks by mod source; a source runs only for profiles that have a mod from it. */
  checks: Partial<Record<InstalledMod['source']['kind'], SourceCheck>>
  /** Sends the new summary to the renderer. */
  publish(summary: UpdateSummary): void
  /** Shows a system notification; a click opens the profile. */
  notify(n: { title: string; body: string; game: string; profileId: string }): void
  /** False while HML's window has focus: the update badges are in view then. */
  shouldNotify(): Promise<boolean>
}

/**
 * Checks every profile of every game for mod updates, then publishes the counts and notifies of
 * updates not announced before (each mod and version once per session). A failing check counts
 * as no updates from that source.
 */
export function createBackgroundChecks(deps: BackgroundCheckDeps): {
  run(): Promise<UpdateSummary>
  summary(): UpdateSummary
  /** Replaces one profile's count, after the renderer checked it itself. */
  setCount(game: string, profileId: string, count: number): void
} {
  let summary: UpdateSummary = {}
  const announced = new Set<string>()
  let running: Promise<UpdateSummary> | null = null

  async function check(): Promise<UpdateSummary> {
    const next: UpdateSummary = {}
    const fresh: { game: string; name: string; profileId: string; profile: string; n: number }[] =
      []
    for (const game of await deps.games()) {
      let profiles: Awaited<ReturnType<BackgroundCheckDeps['profiles']>>
      try {
        profiles = await deps.profiles(game.label)
      } catch {
        continue
      }
      for (const p of profiles) {
        const kinds = new Set(p.mods.map((m) => m.source.kind))
        const found: { modId: string; latest: string }[] = []
        for (const [kind, run] of Object.entries(deps.checks)) {
          if (!run || !kinds.has(kind as InstalledMod['source']['kind'])) continue
          try {
            found.push(...(await run(game.label, p.id)))
          } catch (e) {
            console.warn(
              `Background ${kind} update check of ${game.label}/${p.id} failed: ${e instanceof Error ? e.message : String(e)}`
            )
          }
        }
        if (found.length === 0) continue
        next[game.label] = { ...next[game.label], [p.id]: found.length }
        const keys = found.map((u) => `${game.label}/${p.id}/${u.modId}@${u.latest}`)
        const unseen = keys.filter((k) => !announced.has(k))
        for (const k of unseen) announced.add(k)
        if (unseen.length > 0)
          fresh.push({
            game: game.label,
            name: game.displayName,
            profileId: p.id,
            profile: p.name,
            n: unseen.length
          })
      }
    }
    summary = next
    deps.publish(summary)
    if (fresh.length > 0 && (await deps.shouldNotify())) {
      const total = fresh.reduce((n, f) => n + f.n, 0)
      const first = fresh[0]
      const mods = (n: number): string => (n === 1 ? '1 mod update' : `${n} mod updates`)
      deps.notify(
        fresh.length === 1
          ? {
              title: `${mods(total)} for ${first.name}`,
              body: `In profile ${first.profile}. Click to open it in HML.`,
              game: first.game,
              profileId: first.profileId
            }
          : {
              title: `${mods(total)} available`,
              body: `${[...new Set(fresh.map((f) => f.name))].join(', ')}. Click to open the first in HML.`,
              game: first.game,
              profileId: first.profileId
            }
      )
    }
    return summary
  }

  return {
    run() {
      running ??= check().finally(() => {
        running = null
      })
      return running
    },
    summary: () => summary,
    setCount(game, profileId, count) {
      const forGame = { ...summary[game] }
      if (count > 0) forGame[profileId] = count
      else delete forGame[profileId]
      const next = { ...summary }
      if (Object.keys(forGame).length > 0) next[game] = forGame
      else delete next[game]
      summary = next
      deps.publish(summary)
    }
  }
}
