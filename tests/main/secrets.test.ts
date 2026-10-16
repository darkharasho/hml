import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadSecret, saveSecret, type SecretPort } from '../../src/main/secrets'

let tmp: string
let file: string
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hml-sec-'))
  file = path.join(tmp, 'secrets', 'x.bin')
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const rev = (s: string): string => s.split('').reverse().join('')
const fake = (available = true): SecretPort => ({
  isAvailable: () => available,
  encrypt: (p) => Buffer.from(rev(p)),
  decrypt: (d) => rev(d.toString())
})

describe('secret storage', () => {
  it('round-trips without storing plaintext', async () => {
    await saveSecret(file, fake(), 'hunter2', 'a thing')
    expect((await fs.readFile(file)).toString()).not.toContain('hunter2')
    expect(await loadSecret(file, fake())).toBe('hunter2')
  })
  it('removes the secret when given null', async () => {
    await saveSecret(file, fake(), 'hunter2', 'a thing')
    await saveSecret(file, fake(), null, 'a thing')
    expect(await loadSecret(file, fake())).toBeNull()
  })
  it('throws the what message when storage is unavailable', async () => {
    await expect(saveSecret(file, fake(false), 'x', 'a Nexus Mods API key')).rejects.toThrow(
      "Secure storage isn't available on this system, so HML can't save a Nexus Mods API key."
    )
    expect(await loadSecret(file, fake(false))).toBeNull()
  })
})
