import { describe, expect, test } from 'vitest'
import { describeMods, type ModDetailLookups } from '../../../src/main/share/modDetails'
import type { ModSource } from '../../../src/shared/types'

const lookups = (over: Partial<ModDetailLookups> = {}): ModDetailLookups => ({
  thunderstore: async (n) => ({ iconUrl: `https://ts/${n}.png`, description: n }),
  github: async (o, r) => ({ iconUrl: null, description: `${o}/${r}` }),
  nexus: async (d, id) => ({ iconUrl: null, description: `${d}#${id}` }),
  ...over
})

const ts = (fullName: string): ModSource => ({ kind: 'thunderstore', fullName })
const gh: ModSource = { kind: 'github', owner: 'o', repo: 'r', tag: 'v1', asset: 'a', sha256: 'x' }
const nx: ModSource = { kind: 'nexus', domain: 'repo', modId: 5, fileId: 1 }
const local: ModSource = { kind: 'local', fileName: 'm.zip', sha256: 'x' }

describe('describeMods', () => {
  test('answers each source in order, null for local files', async () => {
    expect(await describeMods([ts('A-B'), gh, nx, local], lookups())).toEqual([
      { iconUrl: 'https://ts/A-B.png', description: 'A-B' },
      { iconUrl: null, description: 'o/r' },
      { iconUrl: null, description: 'repo#5' },
      null
    ])
  })

  test('a failing or empty lookup leaves only its own mod bare', async () => {
    const out = await describeMods(
      [ts('A-B'), gh, nx],
      lookups({
        github: async () => {
          throw new Error('offline')
        },
        nexus: async () => ({ iconUrl: null, description: '' })
      })
    )
    expect(out).toEqual([{ iconUrl: 'https://ts/A-B.png', description: 'A-B' }, null, null])
  })

  test('runs at most four lookups at once and keeps the order', async () => {
    let running = 0
    let peak = 0
    const names = Array.from({ length: 10 }, (_, i) => `O-M${i}`)
    const out = await describeMods(
      names.map(ts),
      lookups({
        thunderstore: async (n) => {
          peak = Math.max(peak, ++running)
          await new Promise((r) => setTimeout(r, Number(n.slice(3)) % 3))
          running--
          return { iconUrl: null, description: n }
        }
      })
    )
    expect(peak).toBe(4)
    expect(out.map((d) => d?.description)).toEqual(names)
  })

  test('nothing to describe is an empty list', async () => {
    expect(await describeMods([], lookups())).toEqual([])
  })
})
