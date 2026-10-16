import { describe, expect, test } from 'vitest'
import { NX_NO_KEY, noSecureStorage } from '../../src/shared/messages'

describe('shared messages', () => {
  test('exact strings the renderer and main both show', () => {
    expect(NX_NO_KEY).toBe('Add your Nexus Mods API key in Settings to download.')
    expect(noSecureStorage('a GitHub token')).toBe(
      "Secure storage isn't available on this system, so HML can't save a GitHub token."
    )
    expect(noSecureStorage('a Nexus Mods API key')).toBe(
      "Secure storage isn't available on this system, so HML can't save a Nexus Mods API key."
    )
  })
})
