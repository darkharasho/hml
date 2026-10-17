import { describe, expect, test } from 'vitest'
import { hasProtonOverride, PROTON_LAUNCH_OPTIONS } from '../../src/shared/protonOptions'

describe('hasProtonOverride', () => {
  test('looks before %command% when there is one, else at all of it', () => {
    expect(PROTON_LAUNCH_OPTIONS).toBe('WINEDLLOVERRIDES="winhttp=n,b" %command%')
    expect(hasProtonOverride(PROTON_LAUNCH_OPTIONS)).toBe(true)
    expect(hasProtonOverride('WINEDLLOVERRIDES="dxgi=n,b;winhttp=n,b" %command% -x')).toBe(true)
    expect(hasProtonOverride('%command% WINEDLLOVERRIDES="winhttp=n,b"')).toBe(false)
    expect(hasProtonOverride('WINEDLLOVERRIDES="winhttp=n,b"')).toBe(true)
    expect(hasProtonOverride('-windowed')).toBe(false)
    expect(hasProtonOverride('')).toBe(false)
    expect(hasProtonOverride(null)).toBe(false)
  })
})
