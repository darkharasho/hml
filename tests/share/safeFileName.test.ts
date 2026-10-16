import { describe, expect, it } from 'vitest'
import { safeFileName } from '../../src/main/share/service'

describe('safeFileName', () => {
  it('prefixes Windows reserved names', () => {
    expect(safeFileName('CON')).toBe('_CON')
    expect(safeFileName('lpt1')).toBe('_lpt1')
  })
  it('strips trailing dots and spaces', () => {
    expect(safeFileName('name...')).toBe('name')
    expect(safeFileName('name. . ')).toBe('name')
  })
  it('replaces unsafe characters and falls back to profile', () => {
    expect(safeFileName('My: Profile?')).toBe('My_ Profile_')
    expect(safeFileName('...')).toBe('profile')
  })
})
