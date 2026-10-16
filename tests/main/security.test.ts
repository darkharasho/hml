import { describe, test, expect } from 'vitest'
import { isAllowedNavigation, isSafeExternalUrl } from '../../src/main/security'

describe('isSafeExternalUrl', () => {
  test('allows http and https', () => {
    expect(isSafeExternalUrl('https://github.com/a/b')).toBe(true)
    expect(isSafeExternalUrl('http://example.com')).toBe(true)
  })
  test.each(['file:///etc/passwd', 'javascript:alert(1)', 'custom-scheme://x', 'not a url', ''])(
    'rejects %s',
    (u) => expect(isSafeExternalUrl(u)).toBe(false)
  )
})

describe('isAllowedNavigation', () => {
  test('dev: same origin only', () => {
    expect(isAllowedNavigation('http://localhost:5173/x', 'http://localhost:5173/')).toBe(true)
    expect(isAllowedNavigation('https://evil.com', 'http://localhost:5173/')).toBe(false)
  })
  test('prod: file only', () => {
    expect(isAllowedNavigation('file:///app/index.html')).toBe(true)
    expect(isAllowedNavigation('https://evil.com')).toBe(false)
    expect(isAllowedNavigation('garbage')).toBe(false)
  })
})
