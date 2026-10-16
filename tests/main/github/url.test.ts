import { describe, it, expect } from 'vitest'
import { parseGithubUrl } from '../../../src/main/github/url'

describe('parseGithubUrl', () => {
  it('parses plain and shorthand forms', () => {
    expect(parseGithubUrl('https://github.com/BepInEx/BepInEx')).toEqual({
      owner: 'BepInEx',
      repo: 'BepInEx'
    })
    expect(parseGithubUrl('github.com/a/b.git/')).toEqual({ owner: 'a', repo: 'b' })
    expect(parseGithubUrl('www.github.com/a/b?tab=readme#x')).toEqual({ owner: 'a', repo: 'b' })
    expect(parseGithubUrl('a/b')).toEqual({ owner: 'a', repo: 'b' })
    expect(parseGithubUrl('  http://github.com/a/b  ')).toEqual({ owner: 'a', repo: 'b' })
  })
  it('parses tag and asset paths', () => {
    expect(parseGithubUrl('https://github.com/a/b/releases/tag/v1.2%2Bx')).toEqual({
      owner: 'a',
      repo: 'b',
      tag: 'v1.2+x'
    })
    expect(parseGithubUrl('https://github.com/a/b/releases/download/v1/Mod.zip')).toEqual({
      owner: 'a',
      repo: 'b',
      tag: 'v1',
      asset: 'Mod.zip'
    })
  })
  it('ignores other paths', () => {
    for (const p of ['releases', 'releases/latest', 'tree/main', 'issues']) {
      expect(parseGithubUrl(`https://github.com/a/b/${p}`)).toEqual({ owner: 'a', repo: 'b' })
    }
  })
  it('rejects invalid input', () => {
    for (const s of [
      'https://gitlab.com/a/b',
      'https://github.com/a',
      'https://github.com/-bad/x',
      'https://github.com/a/..',
      '',
      'not a url'
    ]) {
      expect(parseGithubUrl(s)).toBeNull()
    }
  })
})
