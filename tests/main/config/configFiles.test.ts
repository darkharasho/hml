import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  listConfigFiles,
  readConfigFile,
  writeConfigFile
} from '../../../src/main/config/configFiles'

let tmp: string
let root: string
const put = async (rel: string, text = 'x'): Promise<void> => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await fs.writeFile(path.join(root, rel), text)
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hml-cfg-'))
  root = path.join(tmp, 'profile')
  await fs.mkdir(root)
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('config files', () => {
  test('lists .cfg files anywhere and other formats in config folders', async () => {
    await put('hml-profile.json', '{}')
    await put('BepInEx/config/com.a.cfg')
    await put('BepInEx/config/sub/settings.json')
    await put('BepInEx/plugins/A/manifest.json')
    await put('BepInEx/plugins/A/A.cfg')
    await put('BepInEx/cache/chainloader.cfg')
    await put('UserData/MelonPreferences.toml')
    await put('BepInEx/config/notes.txt')
    expect((await listConfigFiles(root)).map((f) => f.path)).toEqual([
      'BepInEx/config/com.a.cfg',
      'BepInEx/config/sub/settings.json',
      'BepInEx/plugins/A/A.cfg',
      'UserData/MelonPreferences.toml'
    ])
  })

  test("ignores HML's synced-profile base copies", async () => {
    await put('BepInEx/config/com.a.cfg')
    await put('.hml-sync/base/BepInEx/config/com.a.cfg')
    expect((await listConfigFiles(root)).map((f) => f.path)).toEqual(['BepInEx/config/com.a.cfg'])
  })

  test('reads and writes a listed file', async () => {
    await put('BepInEx/config/com.a.cfg', 'A = 1')
    expect(await readConfigFile(root, 'BepInEx/config/com.a.cfg')).toBe('A = 1')
    await writeConfigFile(root, 'BepInEx/config/com.a.cfg', 'A = 2')
    expect(await fs.readFile(path.join(root, 'BepInEx/config/com.a.cfg'), 'utf8')).toBe('A = 2')
    expect(await fs.readdir(path.join(root, 'BepInEx/config'))).toEqual(['com.a.cfg'])
  })

  test('refuses paths outside the profile, non-config files and missing files', async () => {
    await fs.writeFile(path.join(tmp, 'outside.cfg'), 'secret')
    await put('BepInEx/plugins/A/A.dll')
    for (const bad of [
      '../outside.cfg',
      '/etc/passwd.cfg',
      'BepInEx/plugins/A/A.dll',
      'hml-profile.json',
      'BepInEx\\config\\x.cfg',
      'a\0.cfg'
    ]) {
      await expect(readConfigFile(root, bad)).rejects.toThrow()
      await expect(writeConfigFile(root, bad, 'x')).rejects.toThrow()
    }
    await expect(readConfigFile(root, 'BepInEx/config/gone.cfg')).rejects.toThrow(/no longer/)
    expect(await fs.readFile(path.join(tmp, 'outside.cfg'), 'utf8')).toBe('secret')
  })

  test.skipIf(process.platform === 'win32')('refuses a symlink out of the profile', async () => {
    await fs.writeFile(path.join(tmp, 'outside.cfg'), 'secret')
    await fs.mkdir(path.join(root, 'BepInEx/config'), { recursive: true })
    await fs.symlink(path.join(tmp, 'outside.cfg'), path.join(root, 'BepInEx/config/link.cfg'))
    await expect(readConfigFile(root, 'BepInEx/config/link.cfg')).rejects.toThrow()
    await expect(writeConfigFile(root, 'BepInEx/config/link.cfg', 'x')).rejects.toThrow()
    expect(await fs.readFile(path.join(tmp, 'outside.cfg'), 'utf8')).toBe('secret')
  })
})
