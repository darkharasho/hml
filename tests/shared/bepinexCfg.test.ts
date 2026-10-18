import { describe, expect, it } from 'vitest'
import { hasCfgSettings, parseCfg, setCfgValues } from '../../src/shared/bepinexCfg'

const CFG = [
  '## Settings file was created by plugin Cool Mod v1.2.0',
  '## Plugin GUID: com.example.cool',
  '',
  '[General]',
  '',
  '## Turns the mod on.',
  '## Second line.',
  '# Setting type: Boolean',
  '# Default value: true',
  'Enabled = false',
  '',
  '# Setting type: Int32',
  '# Default value: 5',
  '# Acceptable value range: From 1 to 10',
  'Count = 7',
  '',
  '[Keys]',
  '',
  '## Which key',
  '# Setting type: KeyCode',
  '# Default value: F1',
  '# Acceptable values: None, F1, F2',
  'Open Menu = F2',
  '',
  '# Setting type: LogLevel',
  '# Default value: Error, Warning',
  '# Acceptable values: None, Error, Warning, Info',
  '# Multiple values can be set at the same time by separating them with , (e.g. Debug, Warning)',
  'Levels = Error, Warning',
  '',
  'Url = https://x.test/?a=b',
  ''
].join('\r\n')

describe('parseCfg', () => {
  it('reads sections, settings and what the comments say about them', () => {
    const cfg = parseCfg(CFG)
    expect(cfg.header).toEqual([
      'Settings file was created by plugin Cool Mod v1.2.0',
      'Plugin GUID: com.example.cool'
    ])
    expect(cfg.sections.map((s) => s.name)).toEqual(['General', 'Keys'])
    const [enabled, count] = cfg.sections[0].entries
    expect(enabled).toMatchObject({
      key: 'Enabled',
      value: 'false',
      line: 9,
      description: 'Turns the mod on.\nSecond line.',
      type: 'Boolean',
      defaultValue: 'true',
      acceptable: null,
      flags: false,
      range: null
    })
    expect(count).toMatchObject({ value: '7', range: { min: 1, max: 10 }, description: '' })
    const [key, levels, url] = cfg.sections[1].entries
    expect(key).toMatchObject({ key: 'Open Menu', acceptable: ['None', 'F1', 'F2'] })
    expect(levels).toMatchObject({ flags: true, defaultValue: 'Error, Warning' })
    // A setting without comments gets nothing from the one above it.
    expect(url).toMatchObject({ value: 'https://x.test/?a=b', type: null, description: '' })
    expect(hasCfgSettings(cfg)).toBe(true)
  })

  it('reads a file without sections as having no settings', () => {
    expect(hasCfgSettings(parseCfg('just = text\n'))).toBe(false)
    expect(hasCfgSettings(parseCfg(''))).toBe(false)
  })
})

describe('setCfgValues', () => {
  it('rewrites only the value lines, keeping line endings', () => {
    const out = setCfgValues(
      CFG,
      new Map([
        [9, 'true'],
        [14, '3\nInjected = 1']
      ])
    )
    const lines = out.split('\r\n')
    expect(lines[9]).toBe('Enabled = true')
    expect(lines[14]).toBe('Count = 3 Injected = 1')
    expect(lines.filter((_, i) => i !== 9 && i !== 14)).toEqual(
      CFG.split('\r\n').filter((_, i) => i !== 9 && i !== 14)
    )
  })

  it('keeps a BOM and ignores lines that are not settings', () => {
    const text = '﻿[A]\nX = 1\n'
    expect(
      setCfgValues(
        text,
        new Map([
          [1, '2'],
          [0, 'no']
        ])
      )
    ).toBe('﻿[A]\nX = 2\n')
    expect(parseCfg(text).sections[0].entries[0].line).toBe(1)
  })
})
