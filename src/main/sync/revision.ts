import { createHash } from 'node:crypto'
import type { HmlExport } from '../../shared/types'

/** JSON with object keys sorted recursively, so key order never changes the result. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const fields = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    return `{${fields.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Fingerprint of a profile's content. Zip bytes differ by timestamp, so publishing compares this
 * instead. It ignores Map insertion order and object key order.
 */
export function revisionDigest(parts: {
  export: HmlExport
  configs: Map<string, Uint8Array>
}): string {
  const hash = createHash('sha256')
  const enc = new TextEncoder()
  const exportBytes = enc.encode(canonicalJson(parts.export))
  hash.update(`${exportBytes.length}\0`)
  hash.update(exportBytes)
  const paths = [...parts.configs.keys()].sort((a, b) => {
    const x = enc.encode(a)
    const y = enc.encode(b)
    return Buffer.compare(x, y)
  })
  for (const path of paths) {
    const data = parts.configs.get(path) as Uint8Array
    hash.update(enc.encode(path))
    hash.update('\0')
    hash.update(String(data.length))
    hash.update('\0')
    hash.update(data)
  }
  return hash.digest('hex')
}
