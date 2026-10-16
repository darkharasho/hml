import { describe, test, expect } from 'vitest'
import { isAllowedNavigation, parseAllowedExternalUrl } from '../../src/main/security'

describe('parseAllowedExternalUrl', () => {
  test.each([
    'https://thunderstore.io/c/repo/p/A/B/',
    'https://ccdn.thunderstore.io/x.png',
    'https://github.com/a/b',
    'https://www.github.com/a/b',
    'https://www.nexusmods.com/repo/mods/1',
    'https://nexusmods.com/repo/mods/1'
  ])('allows %s', (u) => expect(parseAllowedExternalUrl(u)?.href).toBe(u))
  test.each([
    'http://github.com/a/b',
    'https://github.com:8443/a/b',
    'https://thunderstore.io:444/',
    'https://example.com',
    'https://evilthunderstore.io/',
    'https://github.com.evil.com/',
    'http://www.nexusmods.com/repo/mods/1',
    'https://evil-nexusmods.com/repo/mods/1',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'custom-scheme://x',
    'not a url',
    ''
  ])('rejects %s', (u) => expect(parseAllowedExternalUrl(u)).toBeNull())
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
