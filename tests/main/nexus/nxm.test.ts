import { describe, expect, it } from 'vitest'
import { findNxmArg, linuxDesktopEntry, parseNxm } from '../../../src/main/nexus/nxm'

const OK = 'nxm://repo/mods/5/files/11?key=abc_-1&expires=1234&user_id=77'

describe('parseNxm', () => {
  it('parses a valid link', () => {
    expect(parseNxm(OK)).toEqual({
      domain: 'repo',
      modId: 5,
      fileId: 11,
      key: 'abc_-1',
      expires: 1234,
      userId: 77
    })
  })
  it('allows a missing user_id', () => {
    expect(parseNxm('nxm://repo/mods/5/files/11?key=k&expires=1')?.userId).toBeNull()
  })
  it.each([
    ['missing key', 'nxm://repo/mods/5/files/11?expires=1'],
    ['empty key', 'nxm://repo/mods/5/files/11?key=&expires=1'],
    ['missing expires', 'nxm://repo/mods/5/files/11?key=k'],
    ['non-numeric expires', 'nxm://repo/mods/5/files/11?key=k&expires=soon'],
    ['non-numeric ids', 'nxm://repo/mods/x/files/y?key=k&expires=1'],
    ['dot-dot domain', 'nxm://../mods/1/files/2?key=k&expires=1'],
    ['https', 'https://repo/mods/5/files/11?key=k&expires=1'],
    ['uppercase domain', 'nxm://REPO/mods/5/files/11?key=k&expires=1'],
    ['extra path', 'nxm://repo/mods/5/files/11/x?key=k&expires=1'],
    ['garbage', 'not a url']
  ])('rejects %s', (_n, raw) => {
    expect(parseNxm(raw)).toBeNull()
  })
})

describe('findNxmArg', () => {
  it('finds the link even with Chromium flags after it', () => {
    expect(findNxmArg(['/app/hml', OK, '--no-sandbox', '--flag=1'])).toBe(OK)
  })
  it('returns null when there is none', () => {
    expect(findNxmArg(['/app/hml', '--no-sandbox'])).toBeNull()
  })
})

describe('linuxDesktopEntry', () => {
  it('registers the scheme and quotes the exec path', () => {
    const e = linuxDesktopEntry('/opt/My Apps/HML')
    expect(e).toContain('MimeType=x-scheme-handler/nxm;')
    expect(e).toContain('Exec="/opt/My Apps/HML" %u')
    expect(e).toContain('NoDisplay=true')
  })
  it('escapes special characters in the exec path', () => {
    expect(linuxDesktopEntry('/opt/100%/a$b')).toContain('Exec="/opt/100%%/a\\\\$b" %u')
    expect(linuxDesktopEntry('/x\\y')).toContain('Exec="/x\\\\\\\\y" %u')
  })
})
