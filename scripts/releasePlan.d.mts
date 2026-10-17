export const NOTES_FILE: string
export const RELEASE_BRANCH: string
export function parsePorcelainZ(out: string): string[]
export interface RepoState {
  branch: string
  porcelainZ: string
  version: string
  hasNotes: boolean
  localTags: string[]
  /** Whether the local tag (if any) points at HEAD's commit. */
  localTagAtHead: boolean
  remoteTagExists: boolean
}
export type ReleasePlan =
  | { ok: false; error: string }
  | { ok: true; tag: string; done: true; message: string }
  | {
      ok: true
      tag: string
      done: false
      commitNotes: boolean
      pushBranch: string
      tagAction: 'create' | 'push'
    }
export function planRelease(state: RepoState): ReleasePlan
