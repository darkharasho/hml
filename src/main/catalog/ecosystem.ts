import { z } from 'zod'
import type { Catalog, GameDef, InstallRule } from '../../shared/types'

const ICON_BASE = 'https://ccdn.thunderstore.io/assets/'

const installRuleSchema: z.ZodType<InstallRule> = z.lazy(() =>
  z
    .object({
      route: z.string(),
      defaultFileExtensions: z.array(z.string()).default([]),
      trackingMethod: z.string(),
      subRoutes: z.array(installRuleSchema).default([]),
      isDefaultLocation: z.boolean().default(false)
    })
    .passthrough()
) as z.ZodType<InstallRule>

const r2Schema = z
  .object({
    dataFolderName: z.string().nullish(),
    steamFolderName: z.string().nullish(),
    exeNames: z.array(z.string()).nullish(),
    packageIndex: z.string().nullish(),
    additionalSearchStrings: z.array(z.string()).nullish(),
    packageLoader: z.string().nullish(),
    installRules: z.array(installRuleSchema).nullish()
  })
  .passthrough()

const gameSchema = z
  .object({
    label: z.string().optional(),
    meta: z.object({ displayName: z.string(), iconUrl: z.string().nullish() }).passthrough(),
    distributions: z
      .array(z.object({ platform: z.string(), identifier: z.string().nullish() }).passthrough())
      .nullish(),
    r2modman: z.array(r2Schema).nullish()
  })
  .passthrough()

const ecosystemSchema = z
  .object({
    games: z.record(z.string(), gameSchema),
    modloaderPackages: z
      .array(
        z
          .object({ packageId: z.string(), rootFolder: z.string(), loader: z.string() })
          .passthrough()
      )
      .default([])
  })
  .passthrough()

function resolveIcon(iconUrl: string | null | undefined): string | null {
  if (!iconUrl) return null
  return /^https?:\/\//i.test(iconUrl) ? iconUrl : ICON_BASE + iconUrl.replace(/^\/+/, '')
}

export function parseEcosystem(json: unknown): Catalog {
  const eco = ecosystemSchema.parse(json)
  const games: GameDef[] = []
  for (const [key, game] of Object.entries(eco.games)) {
    const r2 = game.r2modman?.[0]
    if (!r2) continue
    const steam = game.distributions?.find((d) => d.platform === 'steam')
    const loader = r2.packageLoader ?? 'none'
    games.push({
      label: game.label ?? key,
      displayName: game.meta.displayName,
      steamAppId: steam?.identifier ?? null,
      steamFolderName: r2.steamFolderName ?? '',
      exeNames: r2.exeNames ?? [],
      dataFolderName: r2.dataFolderName ?? '',
      loader,
      installRules: r2.installRules ?? [],
      packageIndex: r2.packageIndex ?? null,
      searchStrings: r2.additionalSearchStrings ?? [],
      iconUrl: resolveIcon(game.meta.iconUrl),
      supported: loader === 'bepinex'
    })
  }
  return {
    games,
    modloaderPackages: eco.modloaderPackages.map((m) => ({
      packageId: m.packageId,
      rootFolder: m.rootFolder,
      loader: m.loader
    })),
    fetchedAt: new Date().toISOString()
  }
}

export function searchGames(games: GameDef[], query: string): GameDef[] {
  const q = query.trim().toLowerCase()
  const byName = (a: GameDef, b: GameDef): number => a.displayName.localeCompare(b.displayName)
  if (!q) return [...games].sort(byName)
  const rank = (g: GameDef): number => {
    const names = [g.displayName, g.label, ...g.searchStrings].map((s) => s.toLowerCase())
    if (names.some((n) => n === q)) return 0
    if (names.some((n) => n.startsWith(q))) return 1
    if (names.some((n) => n.includes(q))) return 2
    return -1
  }
  return games
    .map((g) => ({ g, r: rank(g) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || byName(a.g, b.g))
    .map((x) => x.g)
}
