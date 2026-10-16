import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export interface SecretPort {
  isAvailable(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

export async function loadSecret(file: string, secrets: SecretPort): Promise<string | null> {
  if (!secrets.isAvailable()) return null
  try {
    return secrets.decrypt(await fs.readFile(file))
  } catch {
    return null
  }
}

/** Stores `value` encrypted at `file`; null removes it. `what` completes the unavailable-storage message. */
export async function saveSecret(
  file: string,
  secrets: SecretPort,
  value: string | null,
  what: string
): Promise<void> {
  if (value === null) {
    await fs.rm(file, { force: true })
    return
  }
  if (!secrets.isAvailable()) {
    throw new Error(`Secure storage isn't available on this system, so HML can't save ${what}.`)
  }
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tmp, secrets.encrypt(value), { mode: 0o600 })
    await fs.rename(tmp, file)
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}
