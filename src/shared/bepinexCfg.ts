/**
 * BepInEx `.cfg` files: INI-like, with each setting described by the comment lines above it.
 *
 *   [General]
 *
 *   ## What the setting does
 *   # Setting type: Int32
 *   # Default value: 5
 *   # Acceptable value range: From 1 to 10
 *   Count = 5
 *
 * Edits rewrite only the value part of a setting's line, so comments, order and spacing stay.
 */

export interface CfgEntry {
  section: string
  key: string
  value: string
  /** Index of the `key = value` line in the file. */
  line: number
  description: string
  /** `# Setting type:`, e.g. Boolean, Int32, Single, String, KeyCode; null when not given. */
  type: string | null
  defaultValue: string | null
  /** `# Acceptable values:` (an enum); null when any value goes. */
  acceptable: string[] | null
  /** An enum whose values combine, written comma-separated. */
  flags: boolean
  range: { min: number; max: number } | null
}

export interface CfgSection {
  name: string
  entries: CfgEntry[]
}

export interface ParsedCfg {
  /** `##` lines before the first section: the plugin's name, version and GUID. */
  header: string[]
  sections: CfgSection[]
}

const SECTION = /^\s*\[(.+)\]\s*$/
const SETTING = /^\s*([^#;=][^=]*?)\s*=(.*)$/
const NUMBER = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?'
const RANGE = new RegExp(`^From (${NUMBER}) to (${NUMBER})$`)

/** The file split into lines, and the line ending it uses. */
function splitLines(text: string): { lines: string[]; eol: string } {
  return { lines: text.split(/\r?\n/), eol: text.includes('\r\n') ? '\r\n' : '\n' }
}

export function parseCfg(text: string): ParsedCfg {
  const { lines } = splitLines(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  const header: string[] = []
  const sections: CfgSection[] = []
  let current: CfgSection | null = null
  let notes: string[] = []
  const meta = new Map<string, string>()
  const reset = (): void => {
    notes = []
    meta.clear()
  }

  lines.forEach((raw, i) => {
    const line = raw.trim()
    const section = SECTION.exec(line)
    if (section) {
      current = { name: section[1].trim(), entries: [] }
      sections.push(current)
      reset()
      return
    }
    if (line.startsWith('##')) {
      if (current) notes.push(line.slice(2).trim())
      else header.push(line.slice(2).trim())
      return
    }
    if (line.startsWith('#') || line.startsWith(';')) {
      const body = line.slice(1).trim()
      const colon = body.indexOf(':')
      if (colon > 0)
        meta.set(body.slice(0, colon).trim().toLowerCase(), body.slice(colon + 1).trim())
      else if (/^Multiple values can be set/i.test(body)) meta.set('flags', 'true')
      return
    }
    const setting = SETTING.exec(raw)
    if (setting && current) {
      const acceptable = meta.get('acceptable values')
      const range = RANGE.exec(meta.get('acceptable value range') ?? '')
      current.entries.push({
        section: current.name,
        key: setting[1].trim(),
        value: setting[2].trim(),
        line: i,
        description: notes.join('\n'),
        type: meta.get('setting type') ?? null,
        defaultValue: meta.has('default value') ? meta.get('default value')! : null,
        acceptable: acceptable
          ? acceptable
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean)
          : null,
        flags: meta.has('flags'),
        range: range ? { min: Number(range[1]), max: Number(range[2]) } : null
      })
    }
    if (line !== '' || setting) reset()
  })
  return { header, sections }
}

/** True when the file has settings in sections: the form view can show it. */
export function hasCfgSettings(cfg: ParsedCfg): boolean {
  return cfg.sections.some((s) => s.entries.length > 0)
}

/** `text` with each setting line in `values` (line index → new value) rewritten. */
export function setCfgValues(text: string, values: ReadonlyMap<number, string>): string {
  const bom = text.charCodeAt(0) === 0xfeff ? '﻿' : ''
  const { lines, eol } = splitLines(bom ? text.slice(1) : text)
  for (const [i, value] of values) {
    const line = lines[i]
    const eq = line?.indexOf('=') ?? -1
    if (eq === -1 || !SETTING.test(line)) continue
    // One line per setting: a newline in the value would split it.
    lines[i] = `${line.slice(0, eq + 1)} ${value.replace(/[\r\n]+/g, ' ')}`
  }
  return bom + lines.join(eol)
}
