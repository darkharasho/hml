import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { AppPaths } from '../store/paths'

export interface SecretPort {
  isAvailable(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

export async function loadToken(paths: AppPaths, secrets: SecretPort): Promise<string | null> {
  if (!secrets.isAvailable()) return null
  try {
    return secrets.decrypt(await fs.readFile(paths.ghToken))
  } catch {
    return null
  }
}

export async function saveToken(
  paths: AppPaths,
  secrets: SecretPort,
  token: string | null
): Promise<void> {
  if (token === null) {
    await fs.rm(paths.ghToken, { force: true })
    return
  }
  if (!secrets.isAvailable()) {
    throw new Error(
      "Secure storage isn't available on this system, so HML can't save a GitHub token."
    )
  }
  await fs.mkdir(path.dirname(paths.ghToken), { recursive: true })
  const tmp = `${paths.ghToken}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tmp, secrets.encrypt(token), { mode: 0o600 })
    await fs.rename(tmp, paths.ghToken)
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}
