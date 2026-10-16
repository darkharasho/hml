import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectGameFolder } from '../../../src/main/custom/detect'

let dir: string

async function make(...entries: string[]): Promise<void> {
  for (const entry of entries) {
    const full = path.join(dir, entry)
    if (entry.endsWith('/')) await fs.mkdir(full, { recursive: true })
    else {
      await fs.mkdir(path.dirname(full), { recursive: true })
      await fs.writeFile(full, '')
    }
  }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hml-detect-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('detectGameFolder', () => {
  it('detects a Unity Mono game (Trash Day layout)', async () => {
    await make(
      'Trash.exe',
      'UnityPlayer.dll',
      'UnityCrashHandler64.exe',
      'MonoBleedingEdge/',
      'Trash_Data/Managed/Assembly-CSharp.dll'
    )
    expect(await detectGameFolder(dir)).toEqual({
      exeName: 'Trash.exe',
      dataFolderName: 'Trash_Data',
      engine: 'unity-mono',
      nativeLinux: false,
      suggested: 'bepinex5'
    })
  })

  it('detects a Unity IL2CPP game', async () => {
    await make('Game.exe', 'GameAssembly.dll', 'Game_Data/il2cpp_data/')
    expect(await detectGameFolder(dir)).toMatchObject({
      exeName: 'Game.exe',
      dataFolderName: 'Game_Data',
      engine: 'unity-il2cpp',
      suggested: 'bepinex6-il2cpp'
    })
  })

  it('suggests no loader for a non-Unity game with one exe', async () => {
    await make('Thing.exe', 'data.pak')
    expect(await detectGameFolder(dir)).toMatchObject({
      exeName: 'Thing.exe',
      dataFolderName: '',
      engine: 'unknown',
      suggested: 'none'
    })
  })

  it('offers no loader for a native Linux build', async () => {
    await make('Game.x86_64', 'Game_Data/Managed/Assembly-CSharp.dll')
    expect(await detectGameFolder(dir)).toMatchObject({
      exeName: null,
      nativeLinux: true,
      engine: 'unity-mono',
      suggested: 'none'
    })
  })

  it('leaves exeName null when several exes are ambiguous', async () => {
    await make('a.exe', 'b.exe')
    expect((await detectGameFolder(dir)).exeName).toBeNull()
  })

  it('matches names case-insensitively and returns them as on disk', async () => {
    await make('GAME.EXE', 'game_data/Managed/Assembly-CSharp.dll')
    expect(await detectGameFolder(dir)).toMatchObject({
      exeName: 'GAME.EXE',
      dataFolderName: 'game_data',
      engine: 'unity-mono'
    })
  })

  it('throws a readable error for a missing folder', async () => {
    const missing = path.join(dir, 'nope')
    await expect(detectGameFolder(missing)).rejects.toThrow(
      `Couldn't read the game folder ${missing}.`
    )
  })
})
