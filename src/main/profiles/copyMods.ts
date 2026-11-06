import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CopyModsResult, InstalledMod } from '../../shared/types'
import { configsForMod } from '../../shared/configMatch'
import type { AppPaths } from '../store/paths'
import { listConfigFiles } from '../config/configFiles'
import { getProfile, saveProfile } from './profiles'

const exists = (p: string): Promise<boolean> =>
  fs.access(p).then(
    () => true,
    () => false
  )

/** `rel` under `root`, or null when it would escape it. */
function inside(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel)
  return abs.startsWith(root + path.sep) ? abs : null
}

/**
 * Copies mods `modIds` of profile `fromId` into profile `toId` of the same game, files and all,
 * at the same version. A mod the target already has is replaced, keeping its on/off state and
 * the target's own copies of its non-disableable files (configs); a new one is on. The mods'
 * config files are copied where the target has none, so its own settings are never overwritten.
 */
export async function copyMods(
  paths: AppPaths,
  game: string,
  fromId: string,
  toId: string,
  modIds: string[]
): Promise<CopyModsResult> {
  if (fromId === toId) throw new Error('Pick a different profile to copy to.')
  const source = await getProfile(paths, game, fromId)
  let target = await getProfile(paths, game, toId)
  const fromRoot = path.resolve(paths.profileDir(game, fromId))
  const toRoot = path.resolve(paths.profileDir(game, toId))
  const mods = modIds.map((id) => {
    const m = source.mods.find((x) => x.id === id)
    if (!m) throw new Error(`${id} isn't installed in ${source.name}.`)
    return m
  })
  const sourceConfigs = await listConfigFiles(fromRoot)

  const result: CopyModsResult = { copied: [], replaced: [], configs: 0 }
  for (const mod of mods) {
    const prior = target.mods.find((m) => m.id === mod.id)
    const enabled = prior ? prior.enabled : true
    const disableable = new Set(mod.disableable)
    // Files another mod in the target records stay; the replaced copy's own disableable files go.
    const others = new Set(target.mods.filter((m) => m.id !== mod.id).flatMap((m) => m.files))
    if (prior) {
      for (const f of prior.disableable) {
        if (others.has(f)) continue
        const abs = inside(toRoot, f)
        if (!abs) continue
        await fs.rm(abs, { force: true })
        await fs.rm(abs + '.old', { force: true })
      }
    }

    const files: string[] = []
    for (const f of mod.files) {
      const from = inside(fromRoot, f)
      const to = inside(toRoot, f)
      if (!from || !to) continue
      // A disabled mod's disableable files sit on disk as `<file>.old`.
      const src = (await exists(from)) ? from : (await exists(from + '.old')) ? from + '.old' : null
      if (!src) continue
      if (!disableable.has(f) && (await exists(to))) {
        // Keep the target's config; it stays owned only if the target's copy owned it.
        if (prior?.files.includes(f)) files.push(f)
        continue
      }
      const dest = disableable.has(f) && !enabled ? to + '.old' : to
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.copyFile(src, dest)
      files.push(f)
    }

    for (const c of configsForMod(mod, sourceConfigs)) {
      if (files.includes(c.path)) continue
      const from = inside(fromRoot, c.path)
      const to = inside(toRoot, c.path)
      if (!from || !to || (await exists(to))) continue
      await fs.mkdir(path.dirname(to), { recursive: true })
      await fs.copyFile(from, to)
      result.configs++
    }

    const copy: InstalledMod = {
      ...mod,
      enabled,
      files,
      disableable: mod.disableable.filter((f) => files.includes(f)),
      installedAt: new Date().toISOString()
    }
    target = await getProfile(paths, game, toId)
    target = {
      ...target,
      mods: prior ? target.mods.map((m) => (m.id === mod.id ? copy : m)) : [...target.mods, copy]
    }
    await saveProfile(paths, target)
    result.copied.push(mod.id)
    if (prior) result.replaced.push(mod.id)
  }
  return result
}
