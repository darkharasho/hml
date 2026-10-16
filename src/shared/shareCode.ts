import { CODE_LENGTH } from '../../worker/src/code'

export { CROCKFORD, CODE_LENGTH, normalizeCode } from '../../worker/src/code'

/** Display form of a normalized code: `ABCDE-FGHJK`. */
export function formatCode(code: string): string {
  const half = CODE_LENGTH / 2
  return `${code.slice(0, half)}-${code.slice(half)}`
}
