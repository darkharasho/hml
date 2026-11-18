import { describe, expect, it } from 'vitest'
import {
  createNexusPages,
  isNexusPage,
  type PageWindow
} from '../../../src/main/nexus/pages'

const page = (n: number): string => `https://www.nexusmods.com/valheim/mods/${n}?tab=files`
const nxm = (file: number): string =>
  `nxm://valheim/mods/1/files/${file}?key=abc&expires=1700000000&user_id=5`

function setup(): {
  pages: ReturnType<typeof createNexusPages>
  log: string[]
  links: string[]
  closeByUser: () => void
} {
  const log: string[] = []
  const links: string[] = []
  let onClosed: () => void = () => undefined
  let n = 0
  const pages = createNexusPages({
    onLink: (raw) => links.push(raw),
    openWindow(closed): PageWindow {
      const id = ++n
      onClosed = closed
      log.push(`open#${id}`)
      return {
        load: (url) => log.push(`load#${id} ${url}`),
        setTitle: (t) => log.push(`title#${id} ${t}`),
        focus: () => log.push(`focus#${id}`),
        close: () => {
          log.push(`close#${id}`)
          closed()
        }
      }
    }
  })
  return { pages, log, links, closeByUser: () => onClosed() }
}

describe('isNexusPage', () => {
  it('allows https nexusmods.com pages only', () => {
    expect(isNexusPage('https://www.nexusmods.com/valheim/mods/1')).toBe(true)
    expect(isNexusPage('https://nexusmods.com/x')).toBe(true)
    expect(isNexusPage('https://users.nexusmods.com/auth')).toBe(true)
    expect(isNexusPage('http://www.nexusmods.com/x')).toBe(false)
    expect(isNexusPage('https://www.nexusmods.com:444/x')).toBe(false)
    expect(isNexusPage('https://evil-nexusmods.com/x')).toBe(false)
    expect(isNexusPage('https://nexusmods.com.evil.io/x')).toBe(false)
    expect(isNexusPage('javascript:alert(1)')).toBe(false)
    expect(isNexusPage('not a url')).toBe(false)
  })
})

describe('createNexusPages', () => {
  it('opens one window, then loads each queued page after its download link', () => {
    const { pages, log, links } = setup()
    expect(pages.open([page(1), page(2)])).toBe(2)
    expect(pages.open([page(3)])).toBe(1)
    expect(log).toEqual([
      'open#1',
      `load#1 ${page(1)}`,
      'title#1 Nexus Mods download 1 of 2',
      'focus#1',
      'title#1 Nexus Mods download 1 of 3',
      'focus#1'
    ])
    log.length = 0
    expect(pages.take(nxm(10))).toBe(true)
    expect(log).toEqual([`load#1 ${page(2)}`, 'title#1 Nexus Mods download 2 of 3'])
    pages.take(nxm(11))
    log.length = 0
    pages.take(nxm(12))
    expect(log).toEqual(['close#1'])
    expect(links).toEqual([nxm(10), nxm(11), nxm(12)])
  })

  it('handles a link once even when two hooks see it', () => {
    const { pages, links } = setup()
    pages.open([page(1), page(2)])
    pages.take(nxm(10))
    pages.take(nxm(10))
    expect(links).toEqual([nxm(10)])
  })

  it('stops nxm links it cannot read without handling them, and ignores other urls', () => {
    const { pages, links, log } = setup()
    pages.open([page(1)])
    log.length = 0
    expect(pages.take('nxm://valheim/mods/x')).toBe(true)
    expect(pages.take('NXM://valheim/oops')).toBe(true)
    expect(pages.take('https://www.nexusmods.com/next')).toBe(false)
    expect(links).toEqual([])
    expect(log).toEqual([])
  })

  it("asks file pages for the mod manager download, so the click makes an nxm link", () => {
    const { pages, log } = setup()
    pages.open([
      'https://www.nexusmods.com/valheim/mods/7?tab=files&file_id=12',
      'https://www.nexusmods.com/valheim/mods/8?tab=files&file_id=13&nxm=1'
    ])
    expect(log[1]).toBe('load#1 https://www.nexusmods.com/valheim/mods/7?tab=files&file_id=12&nxm=1')
    pages.take(nxm(10))
    expect(log.at(-2)).toBe('load#1 https://www.nexusmods.com/valheim/mods/8?tab=files&file_id=13&nxm=1')
  })

  it('opens nothing for non-Nexus links and drops duplicates', () => {
    const { pages, log } = setup()
    expect(pages.open(['https://example.com/', 'file:///etc/passwd'])).toBe(0)
    expect(log).toEqual([])
    expect(pages.open([page(1), page(1)])).toBe(1)
    expect(log.filter((l) => l.startsWith('load'))).toEqual([`load#1 ${page(1)}`])
  })

  it('a window the user closed forgets its queue; the next open starts a new one', () => {
    const { pages, log, closeByUser } = setup()
    pages.open([page(1), page(2)])
    closeByUser()
    log.length = 0
    pages.open([page(3)])
    expect(log).toEqual(['open#2', `load#2 ${page(3)}`, 'title#2 Nexus Mods download', 'focus#2'])
  })
})
