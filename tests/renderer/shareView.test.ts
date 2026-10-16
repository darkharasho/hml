import { describe, expect, it } from 'vitest'
import type { HmlEvent, ImportResult, ProfileManifest } from '../../src/shared/types'
import {
  SHARE_SOURCE_BADGE,
  fileNameOf,
  gameMismatchNote,
  importProgress,
  importSummary,
  localModsNote
} from '../../src/renderer/src/shareView'

function result(installed: number, unresolved: number): ImportResult {
  return {
    game: 'repo',
    profile: { id: 'p', name: 'P', mods: [] } as unknown as ProfileManifest,
    installed,
    unresolved: Array.from({ length: unresolved }, (_, i) => ({
      name: `Mod${i}`,
      version: '1.0.0',
      kind: 'local' as const,
      reason: 'Local file'
    })),
    warnings: []
  }
}

const progress = (message: string, done: number, total: number): HmlEvent => ({
  type: 'progress',
  message,
  done,
  total
})

describe('localModsNote', () => {
  it('is null when every mod can be shared', () => {
    expect(localModsNote(0)).toBeNull()
  })
  it('counts one local mod', () => {
    expect(localModsNote(1)).toBe("1 local mod won't be included. Others will see it as missing.")
  })
  it('counts several local mods', () => {
    expect(localModsNote(3)).toBe(
      "3 local mods won't be included. Others will see them as missing."
    )
  })
})

describe('importSummary', () => {
  it('counts installed mods out of everything in the profile', () => {
    expect(importSummary(result(4, 1))).toBe('Imported 4 of 5 mods.')
  })
  it('handles an empty profile', () => {
    expect(importSummary(result(0, 0))).toBe('Imported 0 of 0 mods.')
  })
  it('uses the singular for a one-mod profile', () => {
    expect(importSummary(result(1, 0))).toBe('Imported 1 of 1 mod.')
  })
})

describe('importProgress', () => {
  it('reads the import’s own events', () => {
    expect(importProgress(progress('Importing BepInExPack', 2, 5))).toEqual({
      label: 'Importing BepInExPack (3/5)',
      done: 2,
      total: 5
    })
  })
  it('ignores the inner installs’ events', () => {
    expect(importProgress(progress('Installing BepInExPack', 0, 1))).toBeNull()
    expect(importProgress(progress('Done', 5, 5))).toBeNull()
  })
  it('ignores other event types', () => {
    expect(
      importProgress({ type: 'nexus-failed', message: 'Importing x' } as unknown as HmlEvent)
    ).toBeNull()
  })
})

describe('gameMismatchNote', () => {
  it('is null for the current game', () => {
    expect(gameMismatchNote({ game: 'repo', gameName: 'R.E.P.O.' }, 'repo')).toBeNull()
  })
  it('names the other game', () => {
    expect(gameMismatchNote({ game: 'valheim', gameName: 'Valheim' }, 'repo')).toBe(
      'This profile is for Valheim.'
    )
  })
  it('doesn’t double the period after a name that ends with one', () => {
    expect(gameMismatchNote({ game: 'repo', gameName: 'R.E.P.O.' }, 'peak')).toBe(
      'This profile is for R.E.P.O.'
    )
  })
  it('names the game when none is open', () => {
    expect(gameMismatchNote({ game: 'valheim', gameName: 'Valheim' }, null)).toBe(
      'This profile is for Valheim.'
    )
  })
})

describe('fileNameOf', () => {
  it('takes the last segment of a POSIX path', () => {
    expect(fileNameOf('/home/me/Default.hml')).toBe('Default.hml')
  })
  it('takes the last segment of a Windows path', () => {
    expect(fileNameOf('C:\\Users\\me\\My Mods.hml')).toBe('My Mods.hml')
  })
  it('keeps a bare name', () => {
    expect(fileNameOf('Default.hml')).toBe('Default.hml')
  })
})

describe('SHARE_SOURCE_BADGE', () => {
  it('labels every source', () => {
    expect(
      Object.fromEntries(Object.entries(SHARE_SOURCE_BADGE).map(([k, v]) => [k, v.label]))
    ).toEqual({ thunderstore: 'Thunderstore', github: 'GitHub', nexus: 'Nexus', local: 'Local' })
  })
})
