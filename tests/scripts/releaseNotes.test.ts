import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { releaseNotesSection } from '../../scripts/releaseNotes.mjs'

const NOTES = `# Release Notes

Version v1.1.0 — November 2, 2026

## Newer

Second release.

Version v1.0.0 — October 16, 2026

## First release

HML is out.
`

describe('releaseNotesSection', () => {
  test("returns the tag's section body, up to the next version", () => {
    expect(releaseNotesSection(NOTES, 'v1.1.0')).toBe('## Newer\n\nSecond release.')
    expect(releaseNotesSection(NOTES, 'v1.0.0')).toBe('## First release\n\nHML is out.')
  })

  test('null for a missing version', () => {
    expect(releaseNotesSection(NOTES, 'v2.0.0')).toBeNull()
    expect(releaseNotesSection('', 'v1.0.0')).toBeNull()
  })

  test('the version must match exactly, dots included', () => {
    expect(releaseNotesSection('Version v1x0x0 — x\n\nnope', 'v1.0.0')).toBeNull()
    expect(releaseNotesSection('Version v1.0.0.1 — x\n\nnope', 'v1.0.0')).toBeNull()
    expect(releaseNotesSection('Version v1.0.0-beta.1 — x\n\nnope', 'v1.0.0')).toBeNull()
  })

  test('a heading with no notes under it counts as missing', () => {
    expect(releaseNotesSection('Version v1.0.0 — October 16, 2026\n\n  \n', 'v1.0.0')).toBeNull()
  })

  test('Windows line endings', () => {
    expect(releaseNotesSection('Version v1.0.0 — x\r\n\r\nHello\r\n', 'v1.0.0')).toBe('Hello')
  })

  test('only a line starting with "Version v" is a heading', () => {
    const notes = 'Version v1.0.0 — x\n\nSee Version v0.9 notes.\n Version v2.0.0 indented'
    expect(releaseNotesSection(notes, 'v1.0.0')).toBe(
      'See Version v0.9 notes.\n Version v2.0.0 indented'
    )
  })
})

describe('command line (used by the release workflow)', () => {
  const script = join(__dirname, '../../scripts/releaseNotes.mjs')
  const file = join(mkdtempSync(join(tmpdir(), 'hml-notes-')), 'RELEASE_NOTES.md')
  writeFileSync(file, NOTES)

  test('prints the section', () => {
    expect(execFileSync(process.execPath, [script, 'v1.0.0', file], { encoding: 'utf8' })).toBe(
      '## First release\n\nHML is out.\n'
    )
  })

  test('fails without one', () => {
    expect(() =>
      execFileSync(process.execPath, [script, 'v9.9.9', file], { stdio: 'pipe' })
    ).toThrow()
  })
})
