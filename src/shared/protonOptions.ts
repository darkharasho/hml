/** The DLL override Proton needs to load BepInEx's doorstop `winhttp.dll`. */
export const PROTON_DLL_OVERRIDE = 'winhttp=n,b'

/** Steam launch options for a Proton game that has none. */
export const PROTON_LAUNCH_OPTIONS = `WINEDLLOVERRIDES="${PROTON_DLL_OVERRIDE}" %command%`

/**
 * True when Steam launch options already set `winhttp=n,b`: before `%command%` when there is
 * one (after it is a game argument), else anywhere.
 */
export function hasProtonOverride(options: string | null | undefined): boolean {
  if (!options) return false
  const at = options.indexOf('%command%')
  return (at < 0 ? options : options.slice(0, at)).includes(PROTON_DLL_OVERRIDE)
}
