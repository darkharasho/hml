/**
 * Minimal parser for Valve's KeyValues ("VDF") text format, as used by
 * Steam's libraryfolders.vdf and localconfig.vdf.
 */

export type VdfObject = { [key: string]: string | VdfObject }

type Token = { type: 'string' } | { type: 'open' } | { type: 'close' }
/** A token with its decoded value and its span `[start, end)` in the source text. */
export type TokenWithValue = Token & { value: string; start: number; end: number }

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', '\\': '\\', '"': '"' }

export function tokenizeVdf(text: string): TokenWithValue[] {
  const tokens: TokenWithValue[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      i++
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (ch === '{') {
      tokens.push({ type: 'open', value: ch, start: i, end: i + 1 })
      i++
    } else if (ch === '}') {
      tokens.push({ type: 'close', value: ch, start: i, end: i + 1 })
      i++
    } else if (ch === '"') {
      const start = i
      let value = ''
      i++
      let closed = false
      while (i < text.length) {
        const c = text[i]
        if (c === '"') {
          closed = true
          i++
          break
        }
        if (c === '\\' && i + 1 < text.length) {
          const next = text[i + 1]
          // Unknown escapes keep the backslash so Windows-style paths survive.
          value += next in ESCAPES ? ESCAPES[next] : '\\' + next
          i += 2
        } else {
          value += c
          i++
        }
      }
      if (!closed) throw new Error(`VDF: unterminated quoted string at offset ${i}`)
      tokens.push({ type: 'string', value, start, end: i })
    } else {
      const start = i
      let value = ''
      while (i < text.length && !/[\s"{}]/.test(text[i])) {
        value += text[i]
        i++
      }
      tokens.push({ type: 'string', value, start, end: i })
    }
  }
  return tokens
}

/** Plain assignment would turn a `__proto__` key into a prototype change; define it as data. */
function define(obj: VdfObject, key: string, value: string | VdfObject): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true })
}

export function parseVdf(text: string): VdfObject {
  const tokens = tokenizeVdf(text)
  let pos = 0

  function parseBody(nested: boolean): VdfObject {
    const obj: VdfObject = {}
    while (true) {
      if (pos >= tokens.length) {
        if (nested) throw new Error('VDF: missing closing "}"')
        return obj
      }
      const tok = tokens[pos]
      if (tok.type === 'close') {
        if (!nested) throw new Error('VDF: unexpected "}"')
        pos++
        return obj
      }
      if (tok.type !== 'string') throw new Error('VDF: expected a key')
      const key = tok.value
      pos++
      const valueTok = tokens[pos]
      if (valueTok === undefined) throw new Error(`VDF: missing value for "${key}"`)
      if (valueTok.type === 'open') {
        pos++
        define(obj, key, parseBody(true))
      } else if (valueTok.type === 'string') {
        define(obj, key, valueTok.value)
        pos++
      } else {
        throw new Error(`VDF: missing value for "${key}"`)
      }
    }
  }

  return parseBody(false)
}

/**
 * Walks `path` through nested objects. Key matching is case-insensitive;
 * when several keys match, the last one wins (same as parseVdf).
 */
export function vdfGet(obj: VdfObject, ...path: string[]): string | VdfObject | undefined {
  let current: string | VdfObject | undefined = obj
  for (const segment of path) {
    if (typeof current !== 'object') return undefined
    const wanted = segment.toLowerCase()
    let found: string | VdfObject | undefined
    for (const key of Object.keys(current)) {
      if (key.toLowerCase() === wanted) found = current[key]
    }
    current = found
    if (current === undefined) return undefined
  }
  return current
}
