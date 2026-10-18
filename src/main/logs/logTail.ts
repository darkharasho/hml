import { promises as fs } from 'node:fs'

/** How much of a log a first read shows: its end, since that's the run that just happened. */
export const LOG_TAIL_BYTES = 512 * 1024
/** The most one read returns; a faster-growing log catches up over several reads. */
export const LOG_CHUNK_BYTES = 1024 * 1024

export interface LogRead {
  /** The log's size now; 0 when it doesn't exist (yet). */
  size: number
  /** Where the next read starts: just past the last complete line returned. */
  next: number
  /** Complete lines only, so a line being written is never split. */
  text: string
  /** The text doesn't follow on from `from`: a first read, or the log was started over. */
  reset: boolean
}

/**
 * Reads the log at `file` from byte `from` on. From 0, or when the file got shorter (the game
 * started over and truncated it), it reads the last LOG_TAIL_BYTES instead.
 */
export async function readLogFrom(file: string, from: number): Promise<LogRead> {
  let handle: import('node:fs/promises').FileHandle
  try {
    handle = await fs.open(file, 'r')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { size: 0, next: 0, text: '', reset: true }
    }
    throw e
  }
  try {
    const { size } = await handle.stat()
    const reset = !(Number.isSafeInteger(from) && from > 0 && from <= size)
    const start = reset ? Math.max(0, size - LOG_TAIL_BYTES) : from
    const length = Math.min(size - start, LOG_CHUNK_BYTES)
    const buf = Buffer.alloc(length)
    const { bytesRead } = length > 0 ? await handle.read(buf, 0, length, start) : { bytesRead: 0 }
    let body = buf.subarray(0, bytesRead)
    let skipped = 0
    // A tail read starts mid-file: drop the partial first line.
    if (reset && start > 0) {
      const nl = body.indexOf(0x0a)
      skipped = nl === -1 ? body.length : nl + 1
      body = body.subarray(skipped)
    }
    const last = body.lastIndexOf(0x0a)
    const complete = last === -1 ? body.subarray(0, 0) : body.subarray(0, last + 1)
    return {
      size,
      next: start + skipped + complete.length,
      text: complete.toString('utf8'),
      reset
    }
  } finally {
    await handle.close()
  }
}
