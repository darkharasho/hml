import { z } from 'zod'
import { MAX_PATTERN_TOKENS } from './ghTag'

export const MANIFEST_MAX_BYTES = 65536

export interface ManifestMod {
  id: string
  name: string
  description: string
  games: string[]
  tagPrefix?: string
  assetPattern?: string
  icon?: string
  readme?: string
  categories: string[]
  dependencies: string[]
  nsfw: boolean
}

export type ManifestResult =
  { ok: true; mods: ManifestMod[]; warnings: string[] } | { ok: false; error: string }

const isRelPath = (p: string): boolean =>
  !p.startsWith('/') && !p.includes('\\') && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(p)
const noDotDot = (p: string): boolean => !p.split('/').includes('..')
const isHttpsUrl = (u: string): boolean => {
  if (!u.startsWith('https://')) return false
  try {
    return new URL(u).protocol === 'https:'
  } catch {
    return false
  }
}

const repoPath = z
  .string()
  .min(1)
  .max(300)
  .refine(isRelPath, 'must be a relative repo path')
  .refine(noDotDot, 'must not contain ..')

const icon = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (p) => isHttpsUrl(p) || (p.length <= 300 && isRelPath(p)),
    'must be an https URL or repo path'
  )
  .refine((p) => isHttpsUrl(p) || noDotDot(p), 'must not contain ..')

const assetPattern = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (p) => p.split('{version}').length - 1 <= MAX_PATTERN_TOKENS,
    `must contain at most ${MAX_PATTERN_TOKENS} {version} tokens`
  )

const modSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/, 'must match [a-z0-9-]{1,64}'),
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(250),
  games: z.array(z.string().min(1).max(64)).min(1).max(20),
  tagPrefix: z.string().min(1).max(64).optional(),
  assetPattern: assetPattern.optional(),
  icon: icon.optional(),
  readme: repoPath.optional(),
  categories: z.array(z.string().min(1).max(32)).max(5).default([]),
  dependencies: z.array(z.string().min(1).max(200)).max(50).default([]),
  nsfw: z.boolean().default(false)
})

const manifestSchema = z
  .object({
    schema: z.literal(1),
    mods: z.array(modSchema).min(1).max(50)
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>()
    m.mods.forEach((mod, i) => {
      if (seen.has(mod.id))
        ctx.addIssue({ code: 'custom', path: ['mods', i, 'id'], message: 'duplicate id' })
      seen.add(mod.id)
      if (m.mods.length > 1 && !mod.tagPrefix)
        ctx.addIssue({
          code: 'custom',
          path: ['mods', i, 'tagPrefix'],
          message: 'tagPrefix is required when the manifest lists more than one mod'
        })
    })
  })

export function isKnownGameLabel(label: string, tsSlugs: ReadonlySet<string>): boolean {
  return tsSlugs.has(label) || /^nexus-[a-z0-9-]+$/.test(label)
}

export function manifestJsonSchema(): object {
  return z.toJSONSchema(manifestSchema, { io: 'input' })
}

export function validateManifest(
  text: string | null,
  isKnownGame: (label: string) => boolean
): ManifestResult {
  if (text === null) return { ok: false, error: 'no-manifest' }
  if (new TextEncoder().encode(text).length > MANIFEST_MAX_BYTES)
    return { ok: false, error: 'invalid-manifest: (root): too large' }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `invalid-manifest: (root): ${(e as Error).message}` }
  }
  const parsed = manifestSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      ok: false,
      error: `invalid-manifest: ${issue.path.join('.') || '(root)'}: ${issue.message}`
    }
  }
  const warnings: string[] = []
  const mods: ManifestMod[] = []
  for (const mod of parsed.data.mods) {
    const games = mod.games.filter((g) => isKnownGame(g))
    for (const g of mod.games)
      if (!isKnownGame(g)) warnings.push(`${mod.id}: unknown game "${g}" ignored`)
    if (games.length === 0) return { ok: false, error: 'unknown-games' }
    mods.push({ ...mod, games })
  }
  return { ok: true, mods, warnings }
}
