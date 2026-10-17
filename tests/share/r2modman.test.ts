import { strToU8, zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { downloadR2modman, isR2modmanCode, readR2modman } from '../../src/main/share/r2modman'

const CODE = '018f2c3a-1b2c-7d4e-8f90-a1b2c3d4e5f6'
const r2z = (r2x: string, files: Record<string, string> = {}): Uint8Array =>
  zipSync({
    'export.r2x': strToU8(r2x),
    ...Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))
  })
const text = new TextDecoder()

describe('isR2modmanCode', () => {
  it('tells r2modman UUIDs from HML codes', () => {
    expect(isR2modmanCode(CODE)).toBe(true)
    expect(isR2modmanCode(` ${CODE.toUpperCase()} `)).toBe(true)
    expect(isR2modmanCode('ABCDE-FGHJK')).toBe(false)
    expect(isR2modmanCode(`${CODE}0`)).toBe(false)
  })
})

describe('readR2modman', () => {
  it("reads r2modman's YAML export and keeps only BepInEx/config files", () => {
    const data = r2z(
      [
        'profileName: "Crew: night"',
        'mods:',
        '  - name: BepInEx-BepInExPack',
        '    version:',
        '      major: 5',
        '      minor: 4',
        '      patch: 2100',
        '    enabled: true',
        '  - name: Some_Author-Cool_Mod',
        "    version: '1.2.3'",
        '    enabled: false'
      ].join('\n'),
      {
        'config/BepInEx.cfg': 'a',
        'config/sub/b.cfg': 'b',
        'BepInEx/config/c.cfg': 'c',
        'BepInEx/plugins/x/manifest.json': '{}',
        'config/../evil.cfg': 'x'
      }
    )
    const r = readR2modman(data, 'lethal-company')
    expect(r.export).toEqual({
      formatVersion: 1,
      game: 'lethal-company',
      profileName: 'Crew: night',
      mods: [
        {
          source: { kind: 'thunderstore', fullName: 'BepInEx-BepInExPack' },
          version: '5.4.2100',
          enabled: true
        },
        {
          source: { kind: 'thunderstore', fullName: 'Some_Author-Cool_Mod' },
          version: '1.2.3',
          enabled: false
        }
      ]
    })
    expect([...r.configs.keys()].sort()).toEqual([
      'BepInEx/config/BepInEx.cfg',
      'BepInEx/config/c.cfg',
      'BepInEx/config/sub/b.cfg'
    ])
    expect(text.decode(r.configs.get('BepInEx/config/sub/b.cfg'))).toBe('b')
  })

  it('names an unnamed profile and treats a missing enabled flag as on', () => {
    const r = readR2modman(
      r2z('mods:\n  - name: A-B\n    version: { major: 1, minor: 0, patch: 0 }'),
      'g'
    )
    expect(r.export.profileName).toBe('r2modman profile')
    expect(r.export.mods[0].enabled).toBe(true)
  })

  it.each([
    ['not yaml', ': : :\n  - ['],
    ['no mod list', 'profileName: x'],
    ['a bad name', 'mods:\n  - name: ../evil\n    version: { major: 1, minor: 0, patch: 0 }'],
    ['a bad version', 'mods:\n  - name: A-B\n    version: { major: 1, minor: x, patch: 0 }']
  ])('refuses an export with %s', (_, yaml) => {
    expect(() => readR2modman(r2z(yaml), 'g')).toThrow(/damaged/)
  })

  it('refuses a zip without export.r2x, and bytes that are not a zip', () => {
    const msg = "This isn't an r2modman or HML profile file."
    expect(() => readR2modman(zipSync({ 'export.json': strToU8('{}') }), 'g')).toThrow(msg)
    expect(() => readR2modman(new Uint8Array([1, 2, 3]), 'g')).toThrow(msg)
  })
})

describe('downloadR2modman', () => {
  const reply = (body: string, status = 200): typeof fetch =>
    vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch

  it("fetches the code from Thunderstore and decodes r2modman's base64 zip", async () => {
    const zip = r2z('mods: []')
    const f = reply(`#r2modman\n${Buffer.from(zip).toString('base64')}`)
    expect(await downloadR2modman({ fetch: f }, CODE.toUpperCase())).toEqual(zip)
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      `https://thunderstore.io/api/experimental/legacyprofile/get/${CODE}/`
    )
  })

  it('says when a code is unknown, Thunderstore is down, or the reply is not a profile', async () => {
    await expect(downloadR2modman({ fetch: reply('', 404) }, CODE)).rejects.toThrow(
      'No r2modman profile has that code. It may have expired.'
    )
    await expect(downloadR2modman({ fetch: reply('', 503) }, CODE)).rejects.toThrow(
      "Couldn't reach Thunderstore"
    )
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(downloadR2modman({ fetch: down }, CODE)).rejects.toThrow("Couldn't reach")
    await expect(downloadR2modman({ fetch: reply('<html>') }, CODE)).rejects.toThrow(/damaged/)
    await expect(downloadR2modman({ fetch: reply('') }, 'ABCDE-FGHJK')).rejects.toThrow(
      "That isn't a valid r2modman code."
    )
  })
})
