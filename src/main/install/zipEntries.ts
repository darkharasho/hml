import { unzipSync } from 'fflate'

export interface ZipEntries {
  names: string[]
  read(name: string): Uint8Array
}

/** Most bytes HML extracts from one archive (it is held in memory). */
export const MAX_EXTRACTED_BYTES = 4 * 1024 ** 3
export const TOO_LARGE = 'This archive is too large to extract.'

export function readZipEntries(data: Uint8Array, opts: { maxBytes?: number } = {}): ZipEntries {
  const maxBytes = opts.maxBytes ?? MAX_EXTRACTED_BYTES
  // First pass reads only the central directory: the declared sizes are summed and nothing is
  // inflated, so a zip bomb is refused before it can take memory.
  let declared = 0
  unzipSync(data, {
    filter(file) {
      declared += file.originalSize
      if (declared > maxBytes) throw new Error(TOO_LARGE)
      return false
    }
  })
  const files = unzipSync(data)
  const names = Object.keys(files).filter((n) => !n.endsWith('/'))
  return {
    names,
    read(name) {
      const f = files[name]
      if (!f) throw new Error(`No such zip entry: ${name}`)
      return f
    }
  }
}
