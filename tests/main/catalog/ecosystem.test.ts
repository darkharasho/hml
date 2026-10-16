import { describe, it, expect } from 'vitest'
import fixture from '../../fixtures/ecosystem-min.json'
import { parseEcosystem, searchGames } from '../../../src/main/catalog/ecosystem'
import type { GameDef } from '../../../src/shared/types'

const cat = parseEcosystem(fixture)
const get = (l: string): GameDef => cat.games.find((g) => g.label === l)!

describe('parseEcosystem', () => {
  it('parses repo game', () => {
    const g = get('repo')
    expect(g.steamAppId).toBe('3241660')
    expect(g.exeNames).toEqual(['REPO.exe'])
    expect(g.loader).toBe('bepinex')
    expect(g.supported).toBe(true)
    expect(g.installRules).toHaveLength(5)
    expect(g.dataFolderName).toBe('REPO_Data')
    expect(g.searchStrings).toContain('repo')
    expect(g.iconUrl).toBe('https://ccdn.thunderstore.io/assets/repo/repo-cover-360x480.webp')
  })

  it('melonloader game unsupported', () => {
    const g = get('bonelab')
    expect(g.loader).toBe('melonloader')
    expect(g.supported).toBe(false)
    expect(g.steamAppId).toBe('1592190')
  })

  it('reads modloaderPackages and keeps absolute icon urls', () => {
    expect(cat.modloaderPackages.length).toBeGreaterThan(0)
    expect(cat.modloaderPackages[0]).toEqual({
      packageId: 'bbepis-BepInExPack',
      rootFolder: 'BepInExPack',
      loader: 'bepinex'
    })
    const j = JSON.parse(JSON.stringify(fixture))
    j.games.repo.meta.iconUrl = 'https://x.test/i.png'
    expect(parseEcosystem(j).games.find((g) => g.label === 'repo')!.iconUrl).toBe(
      'https://x.test/i.png'
    )
  })

  it('skips a malformed game and parses the others', () => {
    const j = JSON.parse(JSON.stringify(fixture))
    j.games.broken = { meta: {}, r2modman: [{ exeNames: 5 }] }
    const c = parseEcosystem(j)
    expect(c.games.map((g) => g.label).sort()).toEqual(['bonelab', 'repo'])
    expect(() => parseEcosystem({ games: 3 })).toThrow()
  })

  it('skips games without r2modman and defaults missing fields', () => {
    const j = {
      games: {
        a: { meta: { displayName: 'A' } },
        b: { meta: { displayName: 'B' }, r2modman: [{}] }
      }
    }
    const c = parseEcosystem(j)
    expect(c.games).toHaveLength(1)
    expect(c.games[0]).toMatchObject({
      label: 'b',
      steamFolderName: '',
      dataFolderName: '',
      exeNames: [],
      searchStrings: [],
      steamAppId: null,
      iconUrl: null,
      supported: false
    })
  })
})

describe('searchGames', () => {
  const mk = (displayName: string, searchStrings: string[] = []): GameDef => ({
    ...get('repo'),
    label: displayName.toLowerCase(),
    displayName,
    searchStrings
  })
  const games = [mk('Dune Repo Wars'), mk('Repo'), mk('Repository Simulator'), mk('Zed')]

  it('search ranks exact before substring', () => {
    expect(searchGames(games, 'repo').map((g) => g.displayName)).toEqual([
      'Repo',
      'Repository Simulator',
      'Dune Repo Wars'
    ])
  })

  it('search matches additionalSearchStrings', () => {
    const gs = [mk('Zed', ['回收行动'])]
    expect(searchGames(gs, '回收')).toHaveLength(1)
  })

  it('empty query returns all', () => {
    expect(searchGames(games, '')).toHaveLength(4)
  })
})
