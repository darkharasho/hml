import { describe, expect, it } from 'vitest'
import { modForEntry, parseLog } from '../../src/shared/modLog'
import type { InstalledMod } from '../../src/shared/types'

const mod = (name: string): InstalledMod => ({
  id: name,
  name,
  version: '1',
  source: { kind: 'thunderstore', fullName: `a-${name}` },
  enabled: true,
  files: [],
  disableable: [],
  installedAt: ''
})

describe('parseLog', () => {
  it('reads BepInEx entries with their trailing lines', () => {
    const log = [
      'BepInEx 5.4.23 - Game',
      '[Info   :   BepInEx] Loading [More Company 1.9.1]',
      '[Error  : Unity Log] NullReferenceException: Object reference not set',
      'Stack trace:',
      'MoreCompany.Patches.Thing.Postfix () (at <abc>:0)',
      '[Warning:MoreCompany] Something odd',
      ''
    ].join('\r\n')
    expect(parseLog(log, 10)).toEqual([
      { line: 10, level: 'info', source: '', text: 'BepInEx 5.4.23 - Game' },
      { line: 11, level: 'info', source: 'BepInEx', text: 'Loading [More Company 1.9.1]' },
      {
        line: 12,
        level: 'error',
        source: 'Unity Log',
        text: 'NullReferenceException: Object reference not set\nStack trace:\nMoreCompany.Patches.Thing.Postfix () (at <abc>:0)'
      },
      { line: 15, level: 'warning', source: 'MoreCompany', text: 'Something odd' }
    ])
  })

  it('reads UE4SS lines, guessing their level', () => {
    expect(
      parseLog('[12:00:01.123] Starting\n[12:00:02] [Lua] Error: script failed\n').map(
        (e) => e.level
      )
    ).toEqual(['info', 'error'])
  })
})

describe('modForEntry', () => {
  const mods = [mod('MoreCompany'), mod('LC_API'), mod('More')]
  const entry = (level: 'error' | 'info', source: string, text: string) =>
    ({ line: 0, level, source, text }) as const

  it('matches the logger name first', () => {
    expect(modForEntry(entry('info', 'LC_API', 'x'), mods)?.name).toBe('LC_API')
  })
  it('matches an error by the longest mod name in its trace', () => {
    const e = entry('error', 'Unity Log', 'at MoreCompany.Patches.X ()')
    expect(modForEntry(e, mods)?.name).toBe('MoreCompany')
  })
  it('leaves info lines from other loggers unmatched', () => {
    expect(modForEntry(entry('info', 'Unity Log', 'MoreCompany'), mods)).toBeNull()
  })
})
