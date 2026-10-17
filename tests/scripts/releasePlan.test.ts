import { describe, expect, test } from 'vitest'
import { parsePorcelainZ, planRelease, type RepoState } from '../../scripts/releasePlan.mjs'

const state = (over: Partial<RepoState> = {}): RepoState => ({
  branch: 'main',
  porcelainZ: '',
  version: '1.0.0',
  hasNotes: true,
  localTags: [],
  localTagAtHead: false,
  remoteTagExists: false,
  ...over
})

describe('parsePorcelainZ', () => {
  test('paths exactly, including spaces and a rename with its original path', () => {
    expect(parsePorcelainZ(' M RELEASE_NOTES.md\0?? a file.txt\0R  new.ts\0old.ts\0')).toEqual([
      'RELEASE_NOTES.md',
      'a file.txt',
      'new.ts',
      'old.ts'
    ])
    expect(parsePorcelainZ('')).toEqual([])
  })
})

describe('planRelease', () => {
  test('a clean tree with committed notes creates and pushes the tag', () => {
    expect(planRelease(state())).toEqual({
      ok: true,
      tag: 'v1.0.0',
      done: false,
      commitNotes: false,
      pushBranch: 'main',
      tagAction: 'create'
    })
  })

  test('changed notes are committed first, modified or new', () => {
    for (const porcelainZ of [
      ' M RELEASE_NOTES.md\0',
      '?? RELEASE_NOTES.md\0',
      'M  RELEASE_NOTES.md\0'
    ]) {
      expect(planRelease(state({ porcelainZ }))).toMatchObject({ ok: true, commitNotes: true })
    }
  })

  test('refuses off main, naming the branch', () => {
    const r = planRelease(state({ branch: 'feat/x' }))
    expect(r).toMatchObject({ ok: false })
    expect(!r.ok && r.error).toContain('feat/x')
    expect(planRelease(state({ branch: '' }))).toMatchObject({ ok: false })
  })

  test('refuses with any other change, matching the path exactly', () => {
    for (const porcelainZ of [
      ' M src/main/index.ts\0',
      ' M RELEASE_NOTES.md\0?? stray.txt\0',
      ' M docs/RELEASE_NOTES.md\0',
      ' M RELEASE_NOTES.md.bak\0',
      'R  RELEASE_NOTES.md\0OLD_NOTES.md\0'
    ]) {
      const r = planRelease(state({ porcelainZ }))
      expect(r.ok, porcelainZ).toBe(false)
    }
    const r = planRelease(state({ porcelainZ: ' M a.ts\0 M b.ts\0' }))
    expect(!r.ok && r.error).toContain('a.ts\n  b.ts')
  })

  test('refuses without notes for the version', () => {
    const r = planRelease(state({ hasNotes: false }))
    expect(!r.ok && r.error).toContain('Version v1.0.0')
  })

  test('a tag already on origin is done, whether or not it is local', () => {
    for (const localTags of [[], ['v1.0.0']]) {
      expect(planRelease(state({ remoteTagExists: true, localTags }))).toMatchObject({
        ok: true,
        done: true
      })
    }
  })

  test('a local-only tag on HEAD is pushed, after main', () => {
    expect(planRelease(state({ localTags: ['v1.0.0'], localTagAtHead: true }))).toMatchObject({
      ok: true,
      done: false,
      pushBranch: 'main',
      tagAction: 'push'
    })
  })

  test('a local-only tag on another commit is refused', () => {
    const r = planRelease(state({ localTags: ['v1.0.0'], localTagAtHead: false }))
    expect(!r.ok && r.error).toContain('git tag -d v1.0.0')
  })

  test('main is pushed whether or not the notes need committing', () => {
    expect(planRelease(state())).toMatchObject({ commitNotes: false, pushBranch: 'main' })
    expect(planRelease(state({ porcelainZ: ' M RELEASE_NOTES.md\0' }))).toMatchObject({
      commitNotes: true,
      pushBranch: 'main'
    })
  })

  test("a local-only tag won't be pushed past uncommitted notes", () => {
    const r = planRelease(
      state({ localTags: ['v1.0.0'], localTagAtHead: true, porcelainZ: ' M RELEASE_NOTES.md\0' })
    )
    expect(!r.ok && r.error).toContain('git tag -d v1.0.0')
  })

  test('other tags do not count', () => {
    expect(planRelease(state({ localTags: ['v0.9.0', 'v1.0.0-beta'] }))).toMatchObject({
      tagAction: 'create'
    })
  })
})
