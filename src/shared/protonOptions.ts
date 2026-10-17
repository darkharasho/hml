/** The DLL override Proton needs to load BepInEx's doorstop `winhttp.dll`. */
export const PROTON_DLL_OVERRIDE = 'winhttp=n,b'

/**
 * True when Steam launch options already set `<dll>=n,b` (winhttp for BepInEx, dwmapi for
 * unreal_shimloader): before `%command%` when there is one (after it is a game argument), else
 * anywhere.
 */
export function hasProtonOverride(
  options: string | null | undefined,
  dll: 'winhttp' | 'dwmapi' = 'winhttp'
): boolean {
  if (!options) return false
  const at = options.indexOf('%command%')
  return (at < 0 ? options : options.slice(0, at)).includes(`${dll}=n,b`)
}
