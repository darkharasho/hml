import { describe, expect, it } from 'vitest'
import type { BlockEntry } from '../../src/shared/ghCatalog'
import type { CrawledRepo } from '../../worker/src/catalog/listing'
import { isBlocked, serveBlocklist, updateBlockState, type BlockState } from '../../worker/src/catalog/blocklist'

const repo = (owner: string, name: string, id = '1', ownerId = 'O1'): CrawledRepo => ({
  id, ownerId, owner, repo: name, stars: 0, createdAt: '', ownerAvatar: '',
  defaultBranch: 'main', manifest: null, releases: [], archived: false
})
const entry = (target: string, reason = 'bad'): BlockEntry => ({ target, reason, at: '2026-01-01' })
const empty = (): BlockState => ({ ids: {} })

describe('blocklist', () => {
  it('owner entry blocks all its repos', () => {
    expect(isBlocked(repo('evil', 'x'), [entry('evil')], empty())).toBe('bad')
  })
  it('repo entry does not block siblings', () => {
    expect(isBlocked(repo('evil', 'y'), [entry('evil/x')], empty())).toBeNull()
    expect(isBlocked(repo('evil', 'x'), [entry('evil/x')], empty())).toBe('bad')
  })
  it('matches case-insensitively', () => {
    expect(isBlocked(repo('EVIL', 'X'), [entry('evil/x')], empty())).toBe('bad')
    expect(isBlocked(repo('Evil', 'x'), [entry('EVIL')], empty())).toBe('bad')
  })
  it('stays blocked after a repo rename', () => {
    const entries = [entry('evil/x', 'malware')]
    const s1 = updateBlockState(entries, empty(), [repo('evil', 'x', '7')])
    const renamed = repo('evil', 'renamed', '7')
    expect(isBlocked(renamed, entries, s1)).toBe('malware')
    const s2 = updateBlockState(entries, s1, [renamed])
    const names = serveBlocklist(entries, s2).entries[0].names
    expect(names).toContain('evil/x')
    expect(names).toContain('evil/renamed')
    expect(serveBlocklist(entries, s2).entries[0].reason).toBe('malware')
  })
  it('stays blocked after an owner rename via owner id', () => {
    const entries = [entry('evil')]
    const s1 = updateBlockState(entries, empty(), [repo('evil', 'x', '7', 'O9')])
    const moved = repo('newname', 'x', '7', 'O9')
    expect(isBlocked(moved, entries, s1)).toBe('bad')
    expect(isBlocked(repo('newname', 'other', '8', 'O9'), entries, s1)).toBe('bad')
    const s2 = updateBlockState(entries, s1, [moved])
    expect(serveBlocklist(entries, s2).entries[0].names).toEqual(['evil', 'newname'])
  })
  it('removing the entry unblocks and drops state', () => {
    const entries = [entry('evil/x')]
    const s1 = updateBlockState(entries, empty(), [repo('evil', 'x', '7')])
    expect(Object.keys(s1.ids).length).toBe(1)
    const s2 = updateBlockState([], s1, [repo('evil', 'x', '7')])
    expect(s2.ids).toEqual({})
    expect(isBlocked(repo('evil', 'renamed', '7'), [], s2)).toBeNull()
  })
  it('does not mutate input state', () => {
    const s1 = updateBlockState([entry('evil/x')], empty(), [repo('evil', 'x', '7')])
    const snap = JSON.stringify(s1)
    updateBlockState([entry('evil/x')], s1, [repo('evil', 'z', '7')])
    expect(JSON.stringify(s1)).toBe(snap)
  })
})
