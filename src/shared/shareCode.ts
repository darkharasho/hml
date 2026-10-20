import { CODE_LENGTH, SYNC_CODE_LENGTH } from '../../worker/src/code'

export {
  CROCKFORD,
  CODE_LENGTH,
  SYNC_CODE_LENGTH,
  normalizeCode,
  normalizeSyncCode
} from '../../worker/src/code'

/** Display form of a normalized code: `ABCDE-FGHJK`. */
export function formatCode(code: string): string {
  const half = CODE_LENGTH / 2
  return `${code.slice(0, half)}-${code.slice(half)}`
}

/** Display form of a normalized sync code: `ABCD-EFGH-JKMN`. */
export function formatSyncCode(code: string): string {
  const third = SYNC_CODE_LENGTH / 3
  return `${code.slice(0, third)}-${code.slice(third, third * 2)}-${code.slice(third * 2)}`
}
