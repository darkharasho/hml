import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

// RELEASE_NOTES.md holds one section per version, headed by a line like
// `Version v1.2.0 — October 16, 2026`. The release workflow puts the section for
// the pushed tag into the GitHub release body; scripts/release.mjs refuses to tag
// without one.

const HEADING = /^Version (v\d\S*)(?:\s|$)/

/**
 * The body of the `Version <tag> — <date>` section (up to the next `Version v…`
 * line), trimmed; null when there is no such section or it is blank.
 * @param {string} notes
 * @param {string} tag e.g. "v1.0.0"
 * @returns {string | null}
 */
export function releaseNotesSection(notes, tag) {
  let found = false
  let capture = false
  const lines = []
  for (const line of notes.split(/\r?\n/)) {
    const m = HEADING.exec(line)
    if (m) {
      capture = m[1] === tag
      found ||= capture
      continue
    }
    if (capture) lines.push(line)
  }
  const body = lines.join('\n').trim()
  return found && body ? body : null
}

// `node scripts/releaseNotes.mjs v1.0.0 [file]` prints the section, or fails without one.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [tag, file = 'RELEASE_NOTES.md'] = process.argv.slice(2)
  const notes = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const section = tag ? releaseNotesSection(notes, tag) : null
  if (!section) {
    console.error(`No "Version ${tag} — <date>" section with notes in ${file}.`)
    process.exit(1)
  }
  process.stdout.write(section + '\n')
}
