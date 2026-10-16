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
  const INDEX = 'file:///opt/HML/resources/app.asar/out/renderer/index.html'
  test('dev: same origin only', () => {
    expect(isAllowedNavigation('http://localhost:5173/x', 'http://localhost:5173/', INDEX)).toBe(
      true
    )
    expect(isAllowedNavigation('https://evil.com', 'http://localhost:5173/', INDEX)).toBe(false)
  })
  test("prod: only the app's own index.html", () => {
    expect(isAllowedNavigation(INDEX, undefined, INDEX)).toBe(true)
    expect(isAllowedNavigation(INDEX + '#/profiles', undefined, INDEX)).toBe(true)
    expect(isAllowedNavigation('https://evil.com', undefined, INDEX)).toBe(false)
    expect(isAllowedNavigation('garbage', undefined, INDEX)).toBe(false)
  })
  test.each([
    'file:///etc/passwd',
    'file:///home/u/Downloads/evil.html',
    'file:///opt/HML/resources/app.asar/out/renderer/other.html',
    'file://remote-host/opt/HML/resources/app.asar/out/renderer/index.html'
  ])('prod: rejects other file URL %s', (u) => {
    expect(isAllowedNavigation(u, undefined, INDEX)).toBe(false)
  })
})
