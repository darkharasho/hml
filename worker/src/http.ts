export const MAX_BYTES = 10485760
export const TTL_SECONDS = 31536000

export function err(status: number, error: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })
}

/** Reads the body, aborting with null as soon as it exceeds MAX_BYTES. */
export async function readCapped(req: Request): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0)
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

export function isZip(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04
}

const FIRST_ENTRY = 'export.json'

/** True when the zip's first local file header names `export.json`, as every .hml does. */
export function startsWithExport(b: Uint8Array): boolean {
  if (b.length < 30) return false
  const nameLen = b[26] | (b[27] << 8)
  if (nameLen !== FIRST_ENTRY.length || b.length < 30 + nameLen) return false
  return new TextDecoder().decode(b.subarray(30, 30 + nameLen)) === FIRST_ENTRY
}
