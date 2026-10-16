import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isSafeInstallDir, listLibraries } from './steam'
import { parseVdf, vdfGet } from './vdf'

export interface InstalledApp {
  appId: string
  name: string
  installDir: string
}

const TOOL_APP_IDS = new Set([
  '228980', // Steamworks Common Redistributables
  '1070560',
  '1391110',
  '1628350',
  '4183110', // Steam Linux Runtimes
  '1493710', // Proton Experimental
  '2180100', // Proton Hotfix
  '1826330',
  '1161040', // Proton EAC / BattlEye runtimes
  '250820' // SteamVR
])

const TOOL_NAME_PATTERNS = [
  /^Proton\b/i,
  /^Steam Linux Runtime/i,
  /^Steamworks\b/i,
  /\bSoundtrack\b/i,
  /\bOST$/i,
  /\bDemo$/i,
  /\bDedicated Server$/i
]

/** True for Steam tools, runtimes, soundtracks, demos and dedicated servers (not games to mod). */
export function isSteamTool(app: { appId: string; name: string }): boolean {
  return TOOL_APP_IDS.has(app.appId) || TOOL_NAME_PATTERNS.some((re) => re.test(app.name))
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/** Every fully installed Steam game across all libraries, without tools, sorted by name. */
export async function listInstalledApps(root: string): Promise<InstalledApp[]> {
  const byId = new Map<string, InstalledApp>()
  for (const lib of await listLibraries(root)) {
    const apps = path.join(lib, 'steamapps')
    let files: string[]
    try {
      files = await fs.readdir(apps)
    } catch {
      continue
    }
    for (const file of files.sort()) {
      const match = /^appmanifest_(\d+)\.acf$/.exec(file)
      if (!match || byId.has(match[1])) continue
      let state
      try {
        state = vdfGet(parseVdf(await fs.readFile(path.join(apps, file), 'utf8')), 'AppState')
      } catch {
        continue
      }
      const name = vdfGet(state, 'name')
      const installdir = vdfGet(state, 'installdir')
      const flags = Number(vdfGet(state, 'StateFlags'))
      if (typeof name !== 'string' || !name || !isSafeInstallDir(installdir)) continue
      if (!Number.isInteger(flags) || (flags & 4) === 0) continue
      const app = { appId: match[1], name, installDir: path.join(apps, 'common', installdir) }
      if (isSteamTool(app) || !(await isDir(app.installDir))) continue
      byId.set(app.appId, app)
    }
  }
  return [...byId.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
}
