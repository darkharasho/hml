import { promises as fs } from 'node:fs'
import type { HmlApi } from '../../shared/ipc'
import type { ProfileManifest } from '../../shared/types'
import { getProfile } from '../profiles/profiles'
import type { ServiceDeps } from '../services'
import { buildHmlFile } from './hmlFile'
import { uploadShare } from './client'

export interface ShareContext {
  deps: ServiceDeps
  requireGame(label: string): Promise<{ label: string }>
  serialize<T>(game: string, profileId: string, fn: () => Promise<T>): Promise<T>
}

type ShareApi = Pick<HmlApi, 'exportProfileFile' | 'shareProfile'>

/** Replaces characters that are unsafe in file names on Windows or Linux. */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  return cleaned || 'profile'
}

export function createShareServices(ctx: ShareContext): ShareApi {
  const { deps, requireGame, serialize } = ctx

  /** Reads the manifest and zips the profile under the profile lock, so installs can't interleave. */
  async function build(
    game: string,
    profileId: string
  ): Promise<{ profile: ProfileManifest; data: Uint8Array }> {
    const def = await requireGame(game)
    return serialize(def.label, profileId, async () => {
      const profile = await getProfile(deps.paths, def.label, profileId)
      const data = await buildHmlFile(profile, deps.paths.profileDir(def.label, profileId))
      return { profile, data }
    })
  }

  return {
    async exportProfileFile(game, profileId) {
      const def = await requireGame(game)
      // The dialog is modal, so it runs outside the lock; the build happens after it returns.
      const { name } = await getProfile(deps.paths, def.label, profileId)
      const target = await deps.dialog.saveFile({
        title: 'Export profile',
        defaultPath: `${safeFileName(name)}.hml`,
        filters: [{ name: 'HML profile', extensions: ['hml'] }]
      })
      if (!target) return null
      const { data } = await build(game, profileId)
      await fs.writeFile(target, data)
      return target
    },

    async shareProfile(game, profileId) {
      const { profile, data } = await build(game, profileId)
      // The upload can take up to its timeout, so it runs after the lock is released.
      const code = await uploadShare({ fetch: deps.fetch, base: deps.shareBaseUrl }, data)
      return { code, localMods: profile.mods.filter((m) => m.source.kind === 'local').length }
    }
  }
}
