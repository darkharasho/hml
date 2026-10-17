export const NOTES_FILE: string
export const RELEASE_BRANCH: string
export function parsePorcelainZ(out: string): string[]
export interface RepoState {
  branch: string
  porcelainZ: string
  version: string
  hasNotes: boolean
  localTags: string[]
  remoteTagExists: boolean
}
export type ReleasePlan =
  | { ok: false; error: string }
  | { ok: true; tag: string; done: true; message: string }
  | { ok: true; tag: string; done: false; commitNotes: boolean; tagAction: 'create' | 'push' }
export function planRelease(state: RepoState): ReleasePlan
