/**
 * Three-way, per-setting merge of a config file for synced profiles. `base` is the owner's
 * last-applied version, `owner` the new one and `local` the follower's current file. Settings the
 * owner changed are applied; everything else the follower tweaked stays. Anything we can't parse
 * safely falls back to the owner's file whole.
 */

const BOM = '﻿'
const LINE_EXTENSIONS = ['.cfg', '.ini', '.toml']

/** Thrown internally when a file can't be merged per setting. */
class Unmergeable extends Error {}

function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new Unmergeable('invalid utf-8')
  }
}

const stripBom = (text: string): string => (text.startsWith(BOM) ? text.slice(1) : text)

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function extensionOf(rel: string): string {
  const dot = rel.lastIndexOf('.')
  return dot < 0 ? '' : rel.slice(dot).toLowerCase()
}

type LineKind =
  | { kind: 'section'; name: string }
  | { kind: 'setting'; key: string; value: string; eq: number }
  | { kind: 'other' }

function classify(line: string): LineKind {
  const trimmed = line.trim()
  if (trimmed.startsWith('#') || trimmed.startsWith(';')) return { kind: 'other' }
  const header = /^\[([^\]]*)\]$/.exec(trimmed)
  if (header) return { kind: 'section', name: header[1] }
  const eq = line.indexOf('=')
  if (eq < 0) return { kind: 'other' }
  return { kind: 'setting', key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim(), eq }
}

const idOf = (section: string, key: string): string => `${section}\u0000${key}`

interface Setting {
  section: string
  key: string
  value: string
}

function parseSettings(lines: string[], toml: boolean): Map<string, Setting> {
  const settings = new Map<string, Setting>()
  let section = ''
  for (const line of lines) {
    const c = classify(line)
    if (c.kind === 'section') section = c.name
    else if (c.kind === 'setting') {
      if (toml && isTomlMultiline(c.value)) throw new Unmergeable('toml multi-line value')
      const id = idOf(section, c.key)
      if (!settings.has(id)) settings.set(id, { section, key: c.key, value: c.value })
    }
  }
  return settings
}

function isTomlMultiline(value: string): boolean {
  if (value.includes('"""') || value.includes("'''")) return true
  return value.startsWith('[') && !value.includes(']')
}

function splitLines(text: string): { lines: string[]; trailing: boolean } {
  const lines = text.split(/\r?\n/)
  const trailing = lines.length > 1 && lines[lines.length - 1] === ''
  if (trailing) lines.pop()
  return { lines, trailing }
}

function mergeLines(
  rel: string,
  base: Uint8Array | null,
  owner: Uint8Array,
  local: Uint8Array
): Uint8Array {
  const toml = extensionOf(rel) === '.toml'
  const localText = decode(local)
  const bom = localText.startsWith(BOM) ? BOM : ''
  const eol = localText.includes('\r\n') ? '\r\n' : '\n'
  const baseSettings = parseSettings(base ? splitLines(stripBom(decode(base))).lines : [], toml)
  const ownerSettings = parseSettings(splitLines(stripBom(decode(owner))).lines, toml)
  const { lines, trailing } = splitLines(stripBom(localText))
  parseSettings(lines, toml)

  const changed = new Map<string, Setting>()
  for (const [id, s] of ownerSettings) {
    if (baseSettings.get(id)?.value !== s.value) changed.set(id, s)
  }
  const removed = new Set<string>()
  for (const id of baseSettings.keys()) if (!ownerSettings.has(id)) removed.add(id)

  const out: string[] = []
  const present = new Set<string>()
  let section = ''
  for (const line of lines) {
    const c = classify(line)
    if (c.kind === 'section') {
      section = c.name
    } else if (c.kind === 'setting') {
      const id = idOf(section, c.key)
      present.add(id)
      if (removed.has(id)) continue
      const next = changed.get(id)
      if (next && next.value !== c.value) {
        const rest = line.slice(c.eq + 1)
        const spacing = /^\s*/.exec(rest)?.[0] ?? ''
        out.push(`${line.slice(0, c.eq + 1)}${spacing}${next.value}`)
        continue
      }
    }
    out.push(line)
  }

  for (const [id, s] of changed) {
    if (present.has(id)) continue
    const line = `${s.key} = ${s.value}`
    const at = insertionPoint(out, s.section)
    if (at < 0) out.push(`[${s.section}]`, line)
    else out.splice(at, 0, line)
    present.add(id)
  }

  return new TextEncoder().encode(bom + out.join(eol) + (trailing ? eol : ''))
}

/** Index just after the last setting of `target` (or its header); -1 if local lacks the section. */
function insertionPoint(lines: string[], target: string): number {
  let section = ''
  let at = target === '' ? 0 : -1
  lines.forEach((line, i) => {
    const c = classify(line)
    if (c.kind === 'section') {
      section = c.name
      if (section === target && at < 0) at = i + 1
    } else if (c.kind === 'setting' && section === target) {
      at = i + 1
    }
  })
  return at
}

type Json = unknown
type JsonObject = Record<string, Json>

const isObject = (v: Json): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const same = (a: Json, b: Json): boolean => JSON.stringify(a) === JSON.stringify(b)

function mergeObject(base: JsonObject, owner: JsonObject, local: JsonObject): JsonObject {
  const result: JsonObject = { ...local }
  for (const [key, o] of Object.entries(owner)) {
    const l = local[key]
    const b = base[key]
    if (isObject(o) && isObject(l)) {
      result[key] = mergeObject(isObject(b) ? b : {}, o, l)
    } else if (!(key in base) || !same(b, o)) {
      result[key] = o
    }
  }
  for (const key of Object.keys(base)) if (!(key in owner)) delete result[key]
  return result
}

function parseJson(bytes: Uint8Array): Json {
  try {
    return JSON.parse(stripBom(decode(bytes)))
  } catch {
    throw new Unmergeable('invalid json')
  }
}

function mergeJson(base: Uint8Array | null, owner: Uint8Array, local: Uint8Array): Uint8Array {
  const o = parseJson(owner)
  const l = parseJson(local)
  const b = base ? parseJson(base) : {}
  if (!isObject(o) || !isObject(l)) throw new Unmergeable('not an object')
  const localText = decode(local)
  const bom = localText.startsWith(BOM) ? BOM : ''
  const eol = localText.includes('\r\n') ? '\r\n' : '\n'
  const indentMatch = /^([ \t]+)"/m.exec(localText)
  const indent = indentMatch ? (indentMatch[1].startsWith('\t') ? '\t' : indentMatch[1].length) : 2
  const merged = JSON.stringify(mergeObject(isObject(b) ? b : {}, o, l), null, indent)
  const trailing = /\n\s*$/.test(localText) ? eol : ''
  return new TextEncoder().encode(bom + merged.replace(/\n/g, eol) + trailing)
}

export function mergeConfig(
  rel: string,
  base: Uint8Array | null,
  owner: Uint8Array,
  local: Uint8Array | null
): Uint8Array {
  if (local === null) return owner
  if (base && bytesEqual(base, owner)) return local
  const ext = extensionOf(rel)
  try {
    if (LINE_EXTENSIONS.includes(ext)) return mergeLines(rel, base, owner, local)
    if (ext === '.json') return mergeJson(base, owner, local)
  } catch (err) {
    if (!(err instanceof Unmergeable)) throw err
  }
  return owner
}
