import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { releaseNotesSection } from './releaseNotes.mjs'
import { NOTES_FILE, planRelease } from './releasePlan.mjs'

// Cuts a release: validates that RELEASE_NOTES.md has a section for the current
// package.json version, then commits it (if changed), tags v<version>, and pushes
// the tag — which triggers .github/workflows/release.yml.
//
// The release notes themselves are written by hand (by Claude) into
// RELEASE_NOTES.md before running this; there is no AI/network call here.
// The checks live in releasePlan.mjs: it only runs on main with nothing but
// RELEASE_NOTES.md uncommitted, and a tag already on origin is left alone.

const git = (...args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  })

const fail = (msg, err) => {
  console.error(err ? `${msg} ${err?.stderr || err?.message || err}` : msg)
  process.exit(1)
}

const rootDir = process.cwd()
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'))
const version = pkg?.version || '0.0.0'
const notesPath = path.join(rootDir, NOTES_FILE)
const notes = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8') : ''

let plan
try {
  const tag = `v${version}`
  const localTags = git('tag', '--list', tag)
    .split('\n')
    .map((t) => t.trim())
  const localTagAtHead =
    localTags.includes(tag) &&
    git('rev-parse', `${tag}^{commit}`).trim() === git('rev-parse', 'HEAD').trim()
  plan = planRelease({
    branch: git('branch', '--show-current').trim(),
    porcelainZ: git('status', '--porcelain=v1', '-z'),
    version,
    hasNotes: releaseNotesSection(notes, tag) !== null,
    localTags,
    localTagAtHead,
    remoteTagExists: git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`).trim() !== ''
  })
} catch (err) {
  fail('Failed to read the repository state:', err)
}

if (!plan.ok) fail(plan.error)
if (plan.done) {
  console.log(plan.message)
  process.exit(0)
}

if (plan.commitNotes) {
  try {
    git('add', '--', NOTES_FILE)
    git('commit', '-m', `Release notes ${plan.tag}`, '--', NOTES_FILE)
    console.log(`Committed ${NOTES_FILE}.`)
  } catch (err) {
    fail(`Failed to commit ${NOTES_FILE}:`, err)
  }
} else {
  console.log(`${NOTES_FILE} already committed.`)
}

// Before the tag, so a main that is behind origin stops the release here.
try {
  git('push', 'origin', plan.pushBranch)
  console.log(`Pushed ${plan.pushBranch}.`)
} catch (err) {
  fail(`Failed to push ${plan.pushBranch} (pull first if origin is ahead):`, err)
}

try {
  if (plan.tagAction === 'create') git('tag', plan.tag)
  else console.log(`Tag ${plan.tag} exists locally but not on origin; pushing it.`)
  git('push', 'origin', `refs/tags/${plan.tag}`)
  console.log(`Pushed tag ${plan.tag} — the release workflow will build artifacts.`)
} catch (err) {
  fail(`Failed to create/push tag ${plan.tag}:`, err)
}
