export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const CODE_LENGTH = 10

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

/** A fresh share code: 10 Crockford base32 characters (32 symbols, so a byte masked to 5 bits is unbiased). */
export function newCode(rand: (n: number) => Uint8Array = randomBytes): string {
  const bytes = rand(CODE_LENGTH)
  let out = ''
  for (let i = 0; i < CODE_LENGTH; i++) out += CROCKFORD[bytes[i] & 31]
  return out
}

/** Normalizes user input (case, dashes, spaces, look-alikes O/I/L) to a code, or null if invalid. */
export function normalizeCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (s.length !== CODE_LENGTH) return null
  for (const ch of s) if (!CROCKFORD.includes(ch)) return null
  return s
}
