import { promises as fs, type Dirent } from 'node:fs'
import path from 'node:path'
import type { GameDetection } from '../../shared/types'

const IGNORED_EXES = [
  /^UnityCrashHandler(32|64)?\.exe$/i,
  /^unins\d*\.exe$/i,
  /crash|setup|redist|vc_redist/i
]

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile()
  } catch {
    return false
  }
}

/** Works out a game folder's exe, data folder, Unity flavour and the loader to suggest. */
export async function detectGameFolder(dir: string): Promise<GameDetection> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    throw new Error(`Couldn't read the game folder ${dir}.`)
  }
  const find = (name: string, wantDir: boolean): string | undefined =>
    entries.find(
      (e) =>
        e.name.toLowerCase() === name.toLowerCase() &&
        (wantDir ? e.isDirectory() : !e.isDirectory())
    )?.name

  const allExes = entries.filter((e) => !e.isDirectory() && /\.exe$/i.test(e.name))
  const exes = allExes.map((e) => e.name).filter((n) => !IGNORED_EXES.some((re) => re.test(n)))
  const nativeLinux = allExes.length === 0

  let exeName: string | null = null
  let dataFolderName = ''
  for (const exe of exes) {
    const data = find(`${exe.slice(0, -4)}_Data`, true)
    if (data) {
      exeName = exe
      dataFolderName = data
      break
    }
  }
  if (exeName === null && exes.length === 1) exeName = exes[0]

  if (!dataFolderName) {
    // No exe-matched data folder (a native build): fall back to the only `<X>_Data` folder.
    const datas = entries.filter((e) => e.isDirectory() && /_Data$/i.test(e.name))
    if (datas.length === 1 && nativeLinux) dataFolderName = datas[0].name
  }

  let engine: GameDetection['engine'] = 'unknown'
  if (dataFolderName) {
    const data = path.join(dir, dataFolderName)
    const assembly = find('GameAssembly.dll', false)
    const player = find('UnityPlayer.dll', false)
    if (assembly && (await isDir(path.join(data, 'il2cpp_data')))) engine = 'unity-il2cpp'
    else if (
      (await isFile(path.join(data, 'Managed', 'Assembly-CSharp.dll'))) ||
      (player && (await isDir(path.join(data, 'Managed'))))
    ) {
      engine = 'unity-mono'
    }
  }

  const suggested: GameDetection['suggested'] = nativeLinux
    ? 'none'
    : engine === 'unity-il2cpp'
      ? 'bepinex6-il2cpp'
      : engine === 'unity-mono'
        ? 'bepinex5'
        : 'none'
  return { exeName, dataFolderName, engine, nativeLinux, suggested }
}
