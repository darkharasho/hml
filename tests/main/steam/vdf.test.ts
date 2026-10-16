import { describe, test, expect } from 'vitest'
import { parseVdf, vdfGet } from '../../../src/main/steam/vdf'

const libraryFolders = `
"libraryfolders"
{
	"0" { "path" "/home/u/.local/share/Steam" "apps" { "3241660" "123" } }
	"1" { "path" "/mnt/games/SteamLibrary" }
}
`

describe('parseVdf', () => {
  test('parses nested objects', () => {
    const o = parseVdf(libraryFolders)
    expect(o).toEqual({
      libraryfolders: {
        '0': {
          path: '/home/u/.local/share/Steam',
          apps: { '3241660': '123' }
        },
        '1': { path: '/mnt/games/SteamLibrary' }
      }
    })
  })

  test('handles escaped quotes and backslashes', () => {
    const o = parseVdf('"path" "C:\\\\Steam \\"x\\""')
    expect(o).toEqual({ path: 'C:\\Steam "x"' })
  })

  test('ignores // comments', () => {
    const text = `// top comment
"root" // trailing comment
{
	// inside
	"key" "value" // after value
}
// final`
    expect(parseVdf(text)).toEqual({ root: { key: 'value' } })
  })

  test('last duplicate key wins', () => {
    expect(parseVdf('"a" "1" "a" "2"')).toEqual({ a: '2' })
  })

  test('accepts unquoted tokens', () => {
    expect(parseVdf('name value')).toEqual({ name: 'value' })
  })

  test('returns an empty object for empty input', () => {
    expect(parseVdf('')).toEqual({})
  })

  test('throws on unterminated quoted string', () => {
    expect(() => parseVdf('"path" "unterminated')).toThrow()
  })

  test('throws on unbalanced braces', () => {
    expect(() => parseVdf('"a" {')).toThrow()
    expect(() => parseVdf('}')).toThrow()
  })
})

describe('vdfGet', () => {
  test('vdfGet is case-insensitive', () => {
    const o = parseVdf(libraryFolders)
    expect(vdfGet(o, 'LibraryFolders', '0', 'PATH')).toBe('/home/u/.local/share/Steam')
  })

  test('returns nested objects for intermediate and final paths', () => {
    const o = parseVdf(libraryFolders)
    expect(vdfGet(o, 'libraryfolders', '0', 'apps')).toEqual({ '3241660': '123' })
  })

  test('returns undefined for missing keys', () => {
    const o = parseVdf(libraryFolders)
    expect(vdfGet(o, 'libraryfolders', '9', 'path')).toBeUndefined()
    expect(vdfGet(o, 'nope')).toBeUndefined()
  })

  test('returns undefined when descending into a string value', () => {
    const o = parseVdf(libraryFolders)
    expect(vdfGet(o, 'libraryfolders', '1', 'path', 'deeper')).toBeUndefined()
  })
})
