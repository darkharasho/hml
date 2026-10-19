import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { z } from 'zod'
import type { HmlCustomGame, HmlExport, ProfileManifest } from '../../shared/types'
import { readZipEntries, TOO_LARGE } from '../install/zipEntries'

export const MAX_HML_BYTES = 10485760

const NOT_HML = "This isn't an HML profile file."
const DAMAGED = 'This HML profile file is damaged or from a newer HML.'
const TOO_BIG = "This profile's config files are too large to share (over 10 MB)."
export const IMPORT_TOO_BIG = 'This HML profile file is too large to import (over 10 MB).'
/**
 * Profile folders whose settings travel with a profile: BepInEx's, MelonLoader's UserData, and
 * Return of Modding's config.
 */
export const CONFIG_PREFIXES = ['BepInEx/config/', 'UserData/', 'ReturnOfModding/config/']
/**
 * UserData also holds mod data that isn't settings, so only these files are taken from it: the
 * extensions r2modman exports, plus `.toml` (MelonLoader preferences).
 */
const USERDATA_EXTENSIONS = ['.cfg', '.txt', '.json', '.yml', '.yaml', '.ini', '.toml']

const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('thunderstore'), fullName: z.string() }),
  z.object({
    kind: z.literal('github'),
    owner: z.string(),
    repo: z.string(),
    tag: z.string(),
    asset: z.string(),
    sha256: z.string()
  }),
  z.object({ kind: z.literal('nexus'), domain: z.string(), modId: z.number(), fileId: z.number() }),
  z.object({ kind: z.literal('local'), fileName: z.string(), sha256: z.string() })
])

const exportSchema = z.object({
  formatVersion: z.literal(1),
  game: z.string(),
  profileName: z.string(),
  mods: z.array(
    z.object({
      source: sourceSchema,
      version: z.string(),
      enabled: z.boolean(),
      name: z.string().optional(),
      provides: z.array(z.string()).optional(),
      // A malformed value reads as off instead of refusing the file.
      prereleases: z.boolean().optional().catch(undefined)
    })
  ),
  customGame: z
    .object({
      source: z.enum(['steam', 'folder']),
      displayName: z.string(),
      steamAppId: z.string().nullable(),
      loaderChoice: z.enum(['bepinex5', 'bepinex6-mono', 'bepinex6-il2cpp', 'none'])
    })
    .optional()
})

async function collectConfigs(
  dir: string,
  prefix: string,
  out: Record<string, Uint8Array>,
  budget: { left: number },
  keep: (name: string) => boolean = () => true
): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    throw e
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1))
  for (const ent of entries) {
    const full = join(dir, ent.name)
    if (ent.isDirectory()) await collectConfigs(full, `${prefix}${ent.name}/`, out, budget, keep)
    else if (ent.isFile() && keep(ent.name)) {
      const st = await fs.stat(full)
      budget.left -= st.size
      if (budget.left < 0) throw new Error(TOO_BIG)
      out[`${prefix}${ent.name}`] = new Uint8Array(await fs.readFile(full))
    }
  }
}

/** Builds a .hml zip: export.json first, then the profile's BepInEx/config and UserData settings. */
export async function buildHmlFile(
  profile: ProfileManifest,
  profileDir: string,
  opts: { maxBytes?: number; customGame?: HmlCustomGame } = {}
): Promise<Uint8Array> {
  const maxBytes = opts.maxBytes ?? MAX_HML_BYTES
  const exp: HmlExport = {
    formatVersion: 1,
    game: profile.game,
    profileName: profile.name,
    mods: profile.mods.map((m) => ({
      name: m.name,
      source: m.source,
      version: m.version,
      enabled: m.enabled,
      ...(m.provides && m.provides.length > 0 ? { provides: m.provides } : {}),
      ...(m.source.kind === 'github' && m.github?.prereleases ? { prereleases: true } : {})
    })),
    ...(opts.customGame ? { customGame: opts.customGame } : {})
  }
  const json = strToU8(JSON.stringify(exp, null, 2))
  const files: Record<string, Uint8Array> = { 'export.json': json }
  const budget = { left: maxBytes - json.length }
  await collectConfigs(join(profileDir, 'BepInEx', 'config'), CONFIG_PREFIXES[0], files, budget)
  await collectConfigs(join(profileDir, 'UserData'), CONFIG_PREFIXES[1], files, budget, (name) =>
    USERDATA_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))
  )
  await collectConfigs(
    join(profileDir, 'ReturnOfModding', 'config'),
    CONFIG_PREFIXES[2],
    files,
    budget
  )
  return zipSync(files)
}

export function isSafeConfigPath(name: string): boolean {
  if (!CONFIG_PREFIXES.some((p) => name.startsWith(p) && name.length > p.length)) return false
  if (name.includes('\\') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false
  return !name.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')
}

/** Reads a .hml file. `forImport` words a too-large file for an import instead of a share. */
export async function readHmlFile(
  data: Uint8Array,
  opts: { maxBytes?: number; forImport?: boolean } = {}
): Promise<{ export: HmlExport; configs: Map<string, Uint8Array> }> {
  const maxBytes = opts.maxBytes ?? MAX_HML_BYTES
  const tooBig = opts.forImport ? IMPORT_TOO_BIG : TOO_BIG
  if (opts.forImport && data.length > maxBytes) throw new Error(tooBig)
  let zip
  try {
    zip = readZipEntries(data, { maxBytes })
  } catch (e) {
    if (e instanceof Error && e.message === TOO_LARGE) throw new Error(tooBig, { cause: e })
    throw new Error(NOT_HML, { cause: e })
  }
  if (!zip.names.includes('export.json')) throw new Error(DAMAGED)
  let parsed: HmlExport
  try {
    parsed = exportSchema.parse(JSON.parse(new TextDecoder().decode(zip.read('export.json'))))
  } catch {
    throw new Error(DAMAGED)
  }
  const configs = new Map<string, Uint8Array>()
  for (const name of zip.names) if (isSafeConfigPath(name)) configs.set(name, zip.read(name))
  return { export: parsed, configs }
}
