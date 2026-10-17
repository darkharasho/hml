import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  mergeProtonLaunchOptions,
  mostRecentAccountId,
  PROTON_LAUNCH_OPTIONS,
  setVdfLaunchOptions,
  writeProtonLaunchOptions
} from '../../../src/main/steam/launchOptions'
import { readLaunchOptions } from '../../../src/main/steam/steam'
import { parseVdf, vdfGet } from '../../../src/main/steam/vdf'

describe('mergeProtonLaunchOptions', () => {
  test('empty or blank options become the plain option', () => {
    expect(PROTON_LAUNCH_OPTIONS).toBe('WINEDLLOVERRIDES="winhttp=n,b" %command%')
    expect(mergeProtonLaunchOptions('')).toBe(PROTON_LAUNCH_OPTIONS)
    expect(mergeProtonLaunchOptions('   ')).toBe(PROTON_LAUNCH_OPTIONS)
  })

  test('bare game arguments go after %command%', () => {
    expect(mergeProtonLaunchOptions('-screen-width 2560 -screen-height 1440')).toBe(
      'WINEDLLOVERRIDES="winhttp=n,b" %command% -screen-width 2560 -screen-height 1440'
    )
    expect(mergeProtonLaunchOptions('  -windowed ')).toBe(
      'WINEDLLOVERRIDES="winhttp=n,b" %command% -windowed'
    )
  })

  test('options with %command% get the variable at the start of the env part', () => {
    expect(mergeProtonLaunchOptions('%command%')).toBe(PROTON_LAUNCH_OPTIONS)
    expect(mergeProtonLaunchOptions('PROTON_LOG=1 gamemoderun %command% -windowed')).toBe(
      'WINEDLLOVERRIDES="winhttp=n,b" PROTON_LOG=1 gamemoderun %command% -windowed'
    )
    expect(mergeProtonLaunchOptions('%command% -windowed')).toBe(
      'WINEDLLOVERRIDES="winhttp=n,b" %command% -windowed'
    )
  })

  test('an existing WINEDLLOVERRIDES gets winhttp merged into its value', () => {
    expect(mergeProtonLaunchOptions('WINEDLLOVERRIDES="dxgi=n,b" %command%')).toBe(
      'WINEDLLOVERRIDES="dxgi=n,b;winhttp=n,b" %command%'
    )
    expect(mergeProtonLaunchOptions('PROTON_LOG=1 WINEDLLOVERRIDES="dxgi=n,b" %command% -x')).toBe(
      'PROTON_LOG=1 WINEDLLOVERRIDES="dxgi=n,b;winhttp=n,b" %command% -x'
    )
  })

  test('keeps single quotes and quotes an unquoted value', () => {
    expect(mergeProtonLaunchOptions("WINEDLLOVERRIDES='dxgi=n,b' %command%")).toBe(
      "WINEDLLOVERRIDES='dxgi=n,b;winhttp=n,b' %command%"
    )
    expect(mergeProtonLaunchOptions('WINEDLLOVERRIDES=dxgi=n,b %command%')).toBe(
      'WINEDLLOVERRIDES="dxgi=n,b;winhttp=n,b" %command%'
    )
    expect(mergeProtonLaunchOptions('WINEDLLOVERRIDES="" %command%')).toBe(
      'WINEDLLOVERRIDES="winhttp=n,b" %command%'
    )
  })

  test('replaces any other winhttp setting, including in a shared dll list', () => {
    expect(mergeProtonLaunchOptions('WINEDLLOVERRIDES="winhttp=b;dxgi=n" %command%')).toBe(
      'WINEDLLOVERRIDES="dxgi=n;winhttp=n,b" %command%'
    )
    expect(mergeProtonLaunchOptions('WINEDLLOVERRIDES="WinHttp,dxgi=n,b" %command%')).toBe(
      'WINEDLLOVERRIDES="dxgi=n,b;winhttp=n,b" %command%'
    )
    expect(mergeProtonLaunchOptions('WINEDLLOVERRIDES="winhttp=" %command%')).toBe(
      'WINEDLLOVERRIDES="winhttp=n,b" %command%'
    )
  })

  test('a WINEDLLOVERRIDES after %command% is a game argument and is left alone', () => {
    expect(mergeProtonLaunchOptions('%command% WINEDLLOVERRIDES="dxgi=n"')).toBe(
      'WINEDLLOVERRIDES="winhttp=n,b" %command% WINEDLLOVERRIDES="dxgi=n"'
    )
  })

  test('a shell sequence gets the variable directly before %command%', () => {
    expect(mergeProtonLaunchOptions('echo hi; %command%')).toBe(
      'echo hi; WINEDLLOVERRIDES="winhttp=n,b" %command%'
    )
    expect(mergeProtonLaunchOptions('cd /x && PROTON_LOG=1 %command% -y')).toBe(
      'cd /x && PROTON_LOG=1 WINEDLLOVERRIDES="winhttp=n,b" %command% -y'
    )
    expect(mergeProtonLaunchOptions('a || b | gamemoderun %command%')).toBe(
      'a || b | gamemoderun WINEDLLOVERRIDES="winhttp=n,b" %command%'
    )
    expect(mergeProtonLaunchOptions(`bash -c 'exec %command%'`)).toBe(
      `bash -c 'exec WINEDLLOVERRIDES="winhttp=n,b" %command%'`
    )
    expect(mergeProtonLaunchOptions(`sh -c 'exec %command%'`)).toBe(
      `sh -c 'exec WINEDLLOVERRIDES="winhttp=n,b" %command%'`
    )
  })

  test('inside a double-quoted shell string the value goes unquoted', () => {
    expect(mergeProtonLaunchOptions('bash -c "echo; %command%"')).toBe(
      'bash -c "echo; WINEDLLOVERRIDES=winhttp=n,b %command%"'
    )
  })

  test('a shell sequence merges into a WINEDLLOVERRIDES in the last command only', () => {
    expect(mergeProtonLaunchOptions('echo hi; WINEDLLOVERRIDES="dxgi=n" %command%')).toBe(
      'echo hi; WINEDLLOVERRIDES="dxgi=n;winhttp=n,b" %command%'
    )
    expect(mergeProtonLaunchOptions('WINEDLLOVERRIDES="dxgi=n" foo; %command%')).toBe(
      'WINEDLLOVERRIDES="dxgi=n" foo; WINEDLLOVERRIDES="winhttp=n,b" %command%'
    )
  })

  test('winhttp=n,b after %command% does not count as set', () => {
    expect(mergeProtonLaunchOptions('%command% -winhttp=n,b')).toBe(
      'WINEDLLOVERRIDES="winhttp=n,b" %command% -winhttp=n,b'
    )
  })

  test('options that already have winhttp=n,b are returned unchanged', () => {
    for (const s of [
      PROTON_LAUNCH_OPTIONS,
      'WINEDLLOVERRIDES="dxgi=n,b;winhttp=n,b" %command% -x',
      '  WINEDLLOVERRIDES="winhttp=n,b" %command%  '
    ]) {
      expect(mergeProtonLaunchOptions(s)).toBe(s)
    }
  })
})

const T = '\t'
/** A localconfig.vdf laid out the way Steam writes it (tabs, one key per line). */
function steamFile(apps: string, nl = '\n'): string {
  return [
    '"UserLocalConfigStore"',
    '{',
    `${T}"Software"`,
    `${T}{`,
    `${T}${T}"Valve"`,
    `${T}${T}{`,
    `${T}${T}${T}"Steam"`,
    `${T}${T}${T}{`,
    `${T}${T}${T}${T}"SomeKey"${T}${T}"1"`,
    apps,
    `${T}${T}${T}}`,
    `${T}${T}}`,
    `${T}}`,
    `${T}"friends"`,
    `${T}{`,
    `${T}${T}"x"${T}${T}"y"`,
    `${T}}`,
    '}',
    ''
  ]
    .filter((l) => l !== null)
    .join(nl)
}

const APPS_WITH_GAME = [
  `${T}${T}${T}${T}"apps"`,
  `${T}${T}${T}${T}{`,
  `${T}${T}${T}${T}${T}"3241660"`,
  `${T}${T}${T}${T}${T}{`,
  `${T}${T}${T}${T}${T}${T}"LastPlayed"${T}${T}"1700000000"`,
  `${T}${T}${T}${T}${T}${T}"Playtime"${T}${T}"12"`,
  `${T}${T}${T}${T}${T}}`,
  `${T}${T}${T}${T}}`
].join('\n')

const read = (text: string, appId = '3241660'): unknown =>
  vdfGet(
    parseVdf(text),
    'UserLocalConfigStore',
    'Software',
    'Valve',
    'Steam',
    'apps',
    appId,
    'LaunchOptions'
  )

describe('setVdfLaunchOptions', () => {
  test('inserts LaunchOptions as the last key of an existing app block, Steam style', () => {
    const before = steamFile(APPS_WITH_GAME)
    const after = setVdfLaunchOptions(before, '3241660', PROTON_LAUNCH_OPTIONS)
    const line = `${T}${T}${T}${T}${T}${T}"LaunchOptions"${T}${T}"WINEDLLOVERRIDES=\\"winhttp=n,b\\" %command%"\n`
    const anchor = `"Playtime"${T}${T}"12"\n`
    expect(after).toBe(before.replace(anchor, anchor + line))
    expect(read(after)).toBe(PROTON_LAUNCH_OPTIONS)
  })

  test('replaces only the value of an existing LaunchOptions', () => {
    const apps = APPS_WITH_GAME.replace(
      `"Playtime"${T}${T}"12"`,
      `"LaunchOptions"${T}${T}"-windowed \\"a\\""\n${T}${T}${T}${T}${T}${T}"Playtime"${T}${T}"12"`
    )
    const before = steamFile(apps)
    expect(read(before)).toBe('-windowed "a"')
    const after = setVdfLaunchOptions(before, '3241660', 'X "y" \\z')
    expect(after).toBe(before.replace('"-windowed \\"a\\""', '"X \\"y\\" \\\\z"'))
    expect(read(after)).toBe('X "y" \\z')
  })

  test('creates the app block in an existing apps block', () => {
    const before = steamFile(APPS_WITH_GAME)
    const after = setVdfLaunchOptions(before, '42', 'opt')
    const block = [
      `${T}${T}${T}${T}${T}"42"`,
      `${T}${T}${T}${T}${T}{`,
      `${T}${T}${T}${T}${T}${T}"LaunchOptions"${T}${T}"opt"`,
      `${T}${T}${T}${T}${T}}`,
      ''
    ].join('\n')
    const anchor = `${T}${T}${T}${T}${T}}\n${T}${T}${T}${T}}\n`
    expect(after).toBe(before.replace(anchor, `${T}${T}${T}${T}${T}}\n${block}${T}${T}${T}${T}}\n`))
    expect(read(after, '42')).toBe('opt')
    expect(read(after)).toBeUndefined()
  })

  test('creates the apps block when Steam has none', () => {
    const before = steamFile(`${T}${T}${T}${T}"Other"${T}${T}"2"`)
    const after = setVdfLaunchOptions(before, '42', 'opt')
    const block = [
      `${T}${T}${T}${T}"apps"`,
      `${T}${T}${T}${T}{`,
      `${T}${T}${T}${T}${T}"42"`,
      `${T}${T}${T}${T}${T}{`,
      `${T}${T}${T}${T}${T}${T}"LaunchOptions"${T}${T}"opt"`,
      `${T}${T}${T}${T}${T}}`,
      `${T}${T}${T}${T}}`,
      ''
    ].join('\n')
    const anchor = `"Other"${T}${T}"2"\n`
    expect(after).toBe(before.replace(anchor, anchor + block))
    expect(read(after, '42')).toBe('opt')
  })

  test('keeps CRLF line endings throughout', () => {
    const before = steamFile(APPS_WITH_GAME.replace(/\n/g, '\r\n'), '\r\n')
    expect(before.replace(/\r\n/g, '')).not.toContain('\n')
    const after = setVdfLaunchOptions(before, '3241660', 'opt')
    const anchor = `"Playtime"${T}${T}"12"\r\n`
    expect(after).toBe(
      before.replace(anchor, `${anchor}${T.repeat(6)}"LaunchOptions"${T}${T}"opt"\r\n`)
    )
    expect(read(after)).toBe('opt')
  })

  test('edits only Software/Valve/Steam/apps, not apps blocks elsewhere', () => {
    const decoy = (indent: string): string =>
      [
        `${indent}"apps"`,
        `${indent}{`,
        `${indent}${T}"3241660"`,
        `${indent}${T}{`,
        `${indent}${T}}`,
        `${indent}}`
      ].join('\n')
    const before = steamFile(APPS_WITH_GAME)
      .replace(`${T}"friends"\n${T}{\n`, `${T}"friends"\n${T}{\n${decoy(T + T)}\n`)
      .replace(`${T}${T}"Valve"\n`, `${decoy(T + T)}\n${T}${T}"Valve"\n`)
      .replace(`${T}${T}${T}"Steam"\n`, `${decoy(T + T + T)}\n${T}${T}${T}"Steam"\n`)
    expect(before.match(/"apps"/g)).toHaveLength(4)
    const after = setVdfLaunchOptions(before, '3241660', 'opt')
    const anchor = `"Playtime"${T}${T}"12"\n`
    expect(after).toBe(
      before.replace(anchor, `${anchor}${T.repeat(6)}"LaunchOptions"${T}${T}"opt"\n`)
    )
  })

  test('matches keys case-insensitively and edits the last duplicate, as the reader does', () => {
    const before =
      '"UserLocalConfigStore" { "software" { "valve" { "steam" { "Apps" { "7" { "LaunchOptions" "a" } } "apps" { "7" { "a" "b" } } } } } }'
    const after = setVdfLaunchOptions(before, '7', 'new')
    expect(after).toBe(
      '"UserLocalConfigStore" { "software" { "valve" { "steam" { "Apps" { "7" { "LaunchOptions" "a" } } "apps" { "7" { "a" "b" "LaunchOptions" "new" } } } } } }'
    )
    expect(read(after, '7')).toBe('new')
  })

  test('creates missing levels on a one-line file', () => {
    const before = '"UserLocalConfigStore" { "friends" { } }'
    const after = setVdfLaunchOptions(before, '7', 'v')
    expect(read(after, '7')).toBe('v')
    expect(after.startsWith('"UserLocalConfigStore" { "friends" { } ')).toBe(true)
  })

  test('throws on a file without UserLocalConfigStore or that does not parse', () => {
    expect(() => setVdfLaunchOptions('"Other" { }', '7', 'v')).toThrow()
    expect(() => setVdfLaunchOptions('"UserLocalConfigStore" {', '7', 'v')).toThrow()
  })
})

describe('mostRecentAccountId', () => {
  const user = (id: string, recent: string, ts: string): string =>
    `"${id}" { "AccountName" "a" "MostRecent" "${recent}" "Timestamp" "${ts}" }`
  test('prefers MostRecent=1, then the highest Timestamp, as an account id', () => {
    expect(
      mostRecentAccountId(
        `"users" { ${user('76561197960265738', '0', '900')} ${user('76561197960265729', '1', '5')} }`
      )
    ).toBe('1')
    expect(
      mostRecentAccountId(
        `"users" { ${user('76561197960265738', '0', '900')} ${user('76561197960265729', '0', '5')} }`
      )
    ).toBe('10')
  })
  test('null for a missing or broken file', () => {
    expect(mostRecentAccountId('"users" { }')).toBeNull()
    expect(mostRecentAccountId('"users" {')).toBeNull()
  })
})

describe('writeProtonLaunchOptions', () => {
  let root: string
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'hml-lo-'))
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
  const configFile = (user: string): string =>
    path.join(root, 'userdata', user, 'config', 'localconfig.vdf')
  async function put(file: string, text: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
  }

  test('writes every user that has the app block, keeping a backup and other bytes', async () => {
    const withGame = steamFile(APPS_WITH_GAME)
    const without = steamFile(`${T}${T}${T}${T}"Other"${T}${T}"2"`)
    await put(configFile('111'), withGame)
    await put(configFile('222'), withGame.replace('"Playtime"', '"Playtime2"'))
    await put(configFile('333'), without)
    const changed = await writeProtonLaunchOptions(root, '3241660')
    expect(changed).toEqual([configFile('111'), configFile('222')])
    expect(await fs.readFile(configFile('333'), 'utf8')).toBe(without)
    expect(await fs.readFile(configFile('111'), 'utf8')).toBe(
      setVdfLaunchOptions(withGame, '3241660', PROTON_LAUNCH_OPTIONS)
    )
    expect(await fs.readFile(`${configFile('111')}.hml-backup`, 'utf8')).toBe(withGame)
    expect(await readLaunchOptions(root, '3241660')).toBe(PROTON_LAUNCH_OPTIONS)
    const left = await fs.readdir(path.dirname(configFile('111')))
    expect(left.sort()).toEqual(['localconfig.vdf', 'localconfig.vdf.hml-backup'])
  })

  test('merges with existing options and never overwrites an existing backup', async () => {
    const before = steamFile(
      APPS_WITH_GAME.replace('"Playtime"', `"LaunchOptions"${T}${T}"-windowed"\n${T}"Playtime"`)
    )
    await put(configFile('111'), before)
    await put(`${configFile('111')}.hml-backup`, 'older backup')
    await writeProtonLaunchOptions(root, '3241660')
    expect(await readLaunchOptions(root, '3241660')).toBe(`${PROTON_LAUNCH_OPTIONS} -windowed`)
    expect(await fs.readFile(`${configFile('111')}.hml-backup`, 'utf8')).toBe('older backup')
  })

  test('merges an existing value with escaped quotes and backslashes', async () => {
    const before = steamFile(
      APPS_WITH_GAME.replace(
        '"Playtime"',
        `"LaunchOptions"${T}${T}"PROTON_LOG_DIR=\\"C:\\\\x y\\" %command%"\n${T}"Playtime"`
      )
    )
    await put(configFile('111'), before)
    expect(await readLaunchOptions(root, '3241660')).toBe('PROTON_LOG_DIR="C:\\x y" %command%')
    await writeProtonLaunchOptions(root, '3241660')
    expect(await readLaunchOptions(root, '3241660')).toBe(
      'WINEDLLOVERRIDES="winhttp=n,b" PROTON_LOG_DIR="C:\\x y" %command%'
    )
    expect(await fs.readFile(configFile('111'), 'utf8')).toContain(
      `"LaunchOptions"${T}${T}"WINEDLLOVERRIDES=\\"winhttp=n,b\\" PROTON_LOG_DIR=\\"C:\\\\x y\\" %command%"`
    )
  })

  test('does nothing when the option is already set', async () => {
    const before = steamFile(
      APPS_WITH_GAME.replace(
        '"Playtime"',
        `"LaunchOptions"${T}${T}"WINEDLLOVERRIDES=\\"winhttp=n,b\\" %command%"\n${T}"Playtime"`
      )
    )
    await put(configFile('111'), before)
    expect(await writeProtonLaunchOptions(root, '3241660')).toEqual([])
    expect(await fs.readFile(configFile('111'), 'utf8')).toBe(before)
    await expect(fs.access(`${configFile('111')}.hml-backup`)).rejects.toThrow()
  })

  test('without an app block, creates it for the most recent user in loginusers.vdf', async () => {
    const plain = steamFile(APPS_WITH_GAME)
    await put(configFile('1'), plain)
    await put(configFile('10'), plain)
    await put(
      path.join(root, 'config', 'loginusers.vdf'),
      '"users" { "76561197960265738" { "MostRecent" "1" "Timestamp" "1" } }'
    )
    expect(await writeProtonLaunchOptions(root, '42')).toEqual([configFile('10')])
    expect(await fs.readFile(configFile('1'), 'utf8')).toBe(plain)
    expect(await readLaunchOptions(root, '42')).toBe(PROTON_LAUNCH_OPTIONS)
  })

  test('without an app block or loginusers, uses the only user, else throws', async () => {
    await put(configFile('1'), steamFile(APPS_WITH_GAME))
    expect(await writeProtonLaunchOptions(root, '42')).toEqual([configFile('1')])
    await put(configFile('2'), steamFile(APPS_WITH_GAME))
    await expect(writeProtonLaunchOptions(root, '43')).rejects.toThrow(/which Steam account/)
  })

  test('writes through a symlinked localconfig.vdf to its target', async () => {
    const real = path.join(root, 'elsewhere', 'localconfig.vdf')
    const before = steamFile(APPS_WITH_GAME)
    await put(real, before)
    await fs.mkdir(path.dirname(configFile('111')), { recursive: true })
    await fs.symlink(real, configFile('111'))
    expect(await writeProtonLaunchOptions(root, '3241660')).toEqual([configFile('111')])
    expect((await fs.lstat(configFile('111'))).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(real, 'utf8')).toBe(
      setVdfLaunchOptions(before, '3241660', PROTON_LAUNCH_OPTIONS)
    )
    expect(await fs.readdir(path.dirname(real))).toEqual(['localconfig.vdf'])
  })

  test('rejects a non-numeric app id', async () => {
    await expect(writeProtonLaunchOptions(root, '../x')).rejects.toThrow(/app id/)
  })
})
