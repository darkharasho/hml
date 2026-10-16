import { unzipSync } from 'fflate'

export interface ZipEntries {
  names: string[]
  read(name: string): Uint8Array
}

export function readZipEntries(data: Uint8Array): ZipEntries {
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
