export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const CODE_LENGTH = 10
export const SYNC_CODE_LENGTH = 12

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

function makeCode(length: number, rand: (n: number) => Uint8Array): string {
  const bytes = rand(length)
  let out = ''
  for (let i = 0; i < length; i++) out += CROCKFORD[bytes[i] & 31]
  return out
}

function normalize(input: string, length: number): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (s.length !== length) return null
  for (const ch of s) if (!CROCKFORD.includes(ch)) return null
  return s
}

/** A fresh share code: 10 Crockford base32 characters (32 symbols, so a byte masked to 5 bits is unbiased). */
export function newCode(rand: (n: number) => Uint8Array = randomBytes): string {
  return makeCode(CODE_LENGTH, rand)
}

/** A fresh sync code: 12 Crockford base32 characters. */
export function newSyncCode(rand: (n: number) => Uint8Array = randomBytes): string {
  return makeCode(SYNC_CODE_LENGTH, rand)
}

/** Normalizes user input (case, dashes, spaces, look-alikes O/I/L) to a code, or null if invalid. */
export function normalizeCode(input: string): string | null {
  return normalize(input, CODE_LENGTH)
}

/** Same as normalizeCode, for 12-character sync codes. */
export function normalizeSyncCode(input: string): string | null {
  return normalize(input, SYNC_CODE_LENGTH)
}
