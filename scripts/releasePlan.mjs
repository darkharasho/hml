// The decisions scripts/release.mjs makes, as pure functions so tests need no git.

export const NOTES_FILE = 'RELEASE_NOTES.md'
export const RELEASE_BRANCH = 'main'

/**
 * Paths from `git status --porcelain=v1 -z`. A rename or copy lists both its new and its
 * original path, so either one counts as changed.
 * @param {string} out
 * @returns {string[]}
 */
export function parsePorcelainZ(out) {
  const fields = out.split('\0')
  const paths = []
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]
    if (entry.length < 4) continue
    const xy = entry.slice(0, 2)
    paths.push(entry.slice(3))
    // Renames and copies are followed by their original path in the next field.
    if (xy.includes('R') || xy.includes('C')) paths.push(fields[++i])
  }
  return paths
}

/**
 * @typedef {{
 *   branch: string
 *   porcelainZ: string
 *   version: string
 *   hasNotes: boolean
 *   localTags: string[]
 *   localTagAtHead: boolean
 *   remoteTagExists: boolean
 * }} RepoState
 *
 * @typedef {{ ok: false; error: string }
 *   | { ok: true; tag: string; done: true; message: string }
 *   | {
 *       ok: true
 *       tag: string
 *       done: false
 *       commitNotes: boolean
 *       pushBranch: string
 *       tagAction: 'create' | 'push'
 *     }
 * } ReleasePlan
 */

/**
 * What to do for a release of `state.version`, or why not to.
 * @param {RepoState} state
 * @returns {ReleasePlan}
 */
export function planRelease(state) {
  const tag = `v${state.version}`
  if (state.branch !== RELEASE_BRANCH) {
    return {
      ok: false,
      error: `Releases are cut from ${RELEASE_BRANCH}; you're on ${state.branch || 'a detached HEAD'}.`
    }
  }
  const changed = parsePorcelainZ(state.porcelainZ)
  const others = [...new Set(changed.filter((p) => p !== NOTES_FILE))]
  if (others.length > 0) {
    return {
      ok: false,
      error: `Commit or stash these first; only ${NOTES_FILE} may be uncommitted:\n  ${others.join('\n  ')}`
    }
  }
  if (!state.hasNotes) {
    return {
      ok: false,
      error:
        `${NOTES_FILE} has no "Version ${tag} — <date>" section.\n` +
        `Write the notes for ${tag} into ${NOTES_FILE} first, then re-run.`
    }
  }
  if (state.remoteTagExists) {
    return {
      ok: true,
      tag,
      done: true,
      message: `Tag ${tag} is already on origin; nothing to do. Bump the version for a new release.`
    }
  }
  const commitNotes = changed.includes(NOTES_FILE)
  const localTag = state.localTags.includes(tag)
  if (localTag && commitNotes) {
    return {
      ok: false,
      error:
        `Tag ${tag} exists locally but ${NOTES_FILE} has uncommitted changes the tag wouldn't ` +
        `include. Delete it (git tag -d ${tag}) and re-run.`
    }
  }
  if (localTag && !state.localTagAtHead) {
    return {
      ok: false,
      error:
        `Tag ${tag} exists locally on a commit other than HEAD. ` +
        `Delete it (git tag -d ${tag}) and re-run.`
    }
  }
  // main is always pushed before the tag: unpushed commits land on origin, and a main that is
  // behind origin fails there, before anything is tagged.
  return {
    ok: true,
    tag,
    done: false,
    commitNotes,
    pushBranch: RELEASE_BRANCH,
    tagAction: localTag ? 'push' : 'create'
  }
}
