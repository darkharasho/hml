import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export async function readJson<T>(file: string): Promise<T | null> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/** `pretty: false` writes compact JSON, for large caches nobody reads by hand. */
export async function writeJsonAtomic(
  file: string,
  data: unknown,
  { pretty = true }: { pretty?: boolean } = {}
): Promise<void> {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`)
  try {
    await fs.writeFile(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data), 'utf8')
    await fs.rename(tmp, file)
  } catch (e) {
    await fs.rm(tmp, { force: true })
    throw e
  }
}
