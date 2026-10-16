import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makePaths } from '../../../src/main/store/paths'
import { loadToken, saveToken, type SecretPort } from '../../../src/main/github/token'

let tmp: string
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hml-ghtok-'))
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

describe('token storage', () => {
  it('round-trips and does not store plaintext', async () => {
    const paths = makePaths(tmp)
    await saveToken(paths, fake(), 'ghp_secret')
    expect((await fs.readFile(paths.ghToken)).toString()).not.toContain('ghp_secret')
    expect(await loadToken(paths, fake())).toBe('ghp_secret')
  })

  it('saveToken(null) removes the file, even when missing', async () => {
    const paths = makePaths(tmp)
    await saveToken(paths, fake(), 'x')
    await saveToken(paths, fake(), null)
    await expect(fs.access(paths.ghToken)).rejects.toThrow()
    await saveToken(paths, fake(), null)
  })

  it('throws on save when storage is unavailable; load returns null', async () => {
    const paths = makePaths(tmp)
    await expect(saveToken(paths, fake(false), 'x')).rejects.toThrow(
      "Secure storage isn't available on this system, so HML can't save a GitHub token."
    )
    await saveToken(paths, fake(), 'x')
    expect(await loadToken(paths, fake(false))).toBeNull()
  })

  it('returns null when missing or decrypt throws', async () => {
    const paths = makePaths(tmp)
    expect(await loadToken(paths, fake())).toBeNull()
    await saveToken(paths, fake(), 'x')
    const bad: SecretPort = {
      ...fake(),
      decrypt: () => {
        throw new Error('bad')
      }
    }
    expect(await loadToken(paths, bad)).toBeNull()
  })
})
