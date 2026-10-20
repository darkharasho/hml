import { describe, expect, it } from 'vitest'
import { mergeConfig } from '../../../src/main/sync/configMerge'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const dec = (b: Uint8Array): string => new TextDecoder('utf-8', { ignoreBOM: true }).decode(b)
const merge = (rel: string, base: string | null, owner: string, local: string | null): string =>
  dec(
    mergeConfig(
      rel,
      base === null ? null : enc(base),
      enc(owner),
      local === null ? null : enc(local)
    )
  )

describe('mergeConfig', () => {
  const base = '[Keys]\nJump = Space\n[Game]\nDifficulty = 1'

  it("keeps the follower's keybind when the owner changes another setting in the same file", () => {
    const out = merge(
      'BepInEx/config/a.cfg',
      base,
      '[Keys]\nJump = Space\n[Game]\nDifficulty = 3',
      '[Keys]\nJump = F\n[Game]\nDifficulty = 1'
    )
    expect(out).toBe('[Keys]\nJump = F\n[Game]\nDifficulty = 3')
  })

  it('owner wins when both changed the same setting', () => {
    const out = merge(
      'a.ini',
      base,
      '[Keys]\nJump = Tab\n[Game]\nDifficulty = 1',
      '[Keys]\nJump = F\n[Game]\nDifficulty = 1'
    )
    expect(out).toContain('Jump = Tab')
  })

  it('adds an owner-added setting into its section', () => {
    const out = merge(
      'a.cfg',
      base,
      `${base}\nLives = 5`,
      '[Keys]\nJump = F\n[Game]\nDifficulty = 1\n[Other]\nX = 1'
    )
    expect(out).toBe('[Keys]\nJump = F\n[Game]\nDifficulty = 1\nLives = 5\n[Other]\nX = 1')
  })

  it('adds a missing section at the end', () => {
    const out = merge(
      'a.cfg',
      base,
      `${base}\n[New]\nA = 1`,
      '[Keys]\nJump = F\n[Game]\nDifficulty = 1\n'
    )
    expect(out).toBe('[Keys]\nJump = F\n[Game]\nDifficulty = 1\n[New]\nA = 1\n')
  })

  it('removes a setting the owner removed', () => {
    const out = merge(
      'a.cfg',
      base,
      '[Keys]\nJump = Space\n[Game]',
      '[Keys]\nJump = F\n[Game]\nDifficulty = 1'
    )
    expect(out).toBe('[Keys]\nJump = F\n[Game]')
  })

  it('returns local byte-for-byte when the owner file equals the base', () => {
    const local = enc('[Keys]\r\nJump=F  \r\n\r\n')
    const out = mergeConfig('a.cfg', enc(base), enc(base), local)
    expect(out).toEqual(local)
  })

  it('keeps CRLF and BOM, and untouched lines stay byte-identical', () => {
    const local = '﻿[Keys]\r\nJump=F  \r\n\r\n[Game]\r\nDifficulty = 1\r\n'
    const out = merge(
      'a.cfg',
      base,
      '[Keys]\nJump = Space\n[Game]\nDifficulty = 3\nLives = 2',
      local
    )
    expect(out).toBe('﻿[Keys]\r\nJump=F  \r\n\r\n[Game]\r\nDifficulty = 3\r\nLives = 2\r\n')
  })

  it('keeps BepInEx comment lines above settings', () => {
    const b = '[Game]\n## Setting type: Int32\n# Difficulty\nDifficulty = 1\n'
    const local = '[Game]\n## Setting type: Int32\n# Difficulty\nDifficulty = 1\n'
    const out = merge('a.cfg', b, b.replace('1', '4'), local)
    expect(out).toBe('[Game]\n## Setting type: Int32\n# Difficulty\nDifficulty = 4\n')
  })

  it('treats values containing = correctly', () => {
    const out = merge('a.cfg', '[A]\nK = a=b', '[A]\nK = a=c', '[A]\nK = a=b')
    expect(out).toBe('[A]\nK = a=c')
  })

  it('json: merges leaves, owner wins on conflict, arrays replace whole', () => {
    const b = JSON.stringify({ a: { x: 1, y: 2 }, list: [1], gone: true, c: 1 })
    const owner = JSON.stringify({ a: { x: 1, y: 5 }, list: [1, 2], c: 9, added: 'n' })
    const local =
      JSON.stringify({ a: { x: 7, y: 2 }, list: [3], gone: true, c: 4, mine: 1 }, null, 4) + '\n'
    const out = merge('s.JSON', b, owner, local)
    expect(JSON.parse(out)).toEqual({ a: { x: 7, y: 5 }, list: [1, 2], c: 9, added: 'n', mine: 1 })
    expect(out).toMatch(/^ {4}"a"/m)
    expect(out.endsWith('}\n')).toBe(true)
  })

  it('unknown extension returns owner whole', () => {
    expect(merge('a.txt', 'a', 'b', 'c')).toBe('b')
  })

  it('invalid json returns owner whole', () => {
    expect(merge('a.json', '{}', '{"a":1}', '{nope')).toBe('{"a":1}')
  })

  it('invalid utf-8 returns owner whole', () => {
    const out = mergeConfig(
      'a.cfg',
      enc('[A]\nK = 1'),
      enc('[A]\nK = 2'),
      new Uint8Array([0xff, 0xfe, 0x41])
    )
    expect(dec(out)).toBe('[A]\nK = 2')
  })

  it('toml multi-line string returns owner whole', () => {
    const owner = 'a = 2\nb = """\nx\n"""'
    expect(merge('p.toml', 'a = 1', owner, 'a = 1')).toBe(owner)
    expect(merge('p.toml', 'a = 1', 'a = 2\nl = [\n1,\n]', 'a = 1')).toBe('a = 2\nl = [\n1,\n]')
    expect(merge('p.toml', 'a = 1', 'a = 2\nl = [1, 2]', 'a = 1')).toBe('a = 2\nl = [1, 2]')
  })

  it('null base counts every owner setting as changed', () => {
    expect(merge('a.cfg', null, '[A]\nK = 2\nN = 1', '[A]\nK = 1')).toBe('[A]\nK = 2\nN = 1')
  })

  it('null local returns owner', () => {
    expect(merge('a.cfg', base, 'x = 1', null)).toBe('x = 1')
  })
})
