import type { HmlApi } from '../../shared/ipc'

/** API methods that change a profile's mods, refused on a follower outside a sync apply. */
export const FOLLOWER_LOCKED = [
  'installFromFile',
  'installFromPaths',
  'setModEnabled',
  'uninstallMod',
  'setModHeld',
  'tsInstall',
  'tsUpdate',
  'ghInstall',
  'ghUpdate',
  'ghSetUpdateMode',
  'ghSetPrereleases',
  'ghInstallRelease',
  'nxInstall',
  'nxUpdate',
  'installLoader'
] as const satisfies readonly (keyof HmlApi)[]

export const FOLLOWER_LOCKED_MESSAGE =
  'This profile is synced from a friend. Detach it to change its mods.'

/**
 * Wraps the methods in FOLLOWER_LOCKED so they throw FOLLOWER_LOCKED_MESSAGE when their profile
 * (`args[0]`, `args[1]`) follows a sync code and no sync apply is running for it. Every other
 * method passes through unchanged.
 */
export function lockFollowers<T extends HmlApi>(
  api: T,
  guard: {
    isFollower(game: string, profileId: string): Promise<boolean>
    isApplying(game: string, profileId: string): boolean
  }
): T {
  const out: T = { ...api }
  const methods = out as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
  for (const name of FOLLOWER_LOCKED) {
    const inner = methods[name]
    if (typeof inner !== 'function') continue
    methods[name] = async (...args: unknown[]) => {
      const [game, profileId] = args
      if (
        typeof game === 'string' &&
        typeof profileId === 'string' &&
        !guard.isApplying(game, profileId) &&
        (await guard.isFollower(game, profileId))
      ) {
        throw new Error(FOLLOWER_LOCKED_MESSAGE)
      }
      return inner(...args)
    }
  }
  return out
}
