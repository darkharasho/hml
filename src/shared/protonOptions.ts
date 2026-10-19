/** The DLL override Proton needs to load BepInEx's doorstop `winhttp.dll`. */
export const PROTON_DLL_OVERRIDE = 'winhttp=n,b'

/**
 * A DLL a loader needs Wine to take from the game folder before its own: BepInEx's doorstop
 * `winhttp`, unreal_shimloader's `dwmapi`, MelonLoader's and Return of Modding's `version`,
 * lovely's `winmm`, or Hell2Modding's `d3d12`.
 */
export type ProxyDll = 'winhttp' | 'dwmapi' | 'version' | 'winmm' | 'd3d12'

/**
 * True when Steam launch options already set `<dll>=n,b`: before `%command%` when there is one
 * (after it is a game argument), else anywhere.
 */
export function hasProtonOverride(
  options: string | null | undefined,
  dll: ProxyDll = 'winhttp'
): boolean {
  if (!options) return false
  const at = options.indexOf('%command%')
  return (at < 0 ? options : options.slice(0, at)).includes(`${dll}=n,b`)
}
