import type { HmlApi } from '../../shared/ipc'

/** The privileged API exposed by the preload script. */
export const api: HmlApi = window.hml

/** Absolute filesystem path of a dropped File (Electron webUtils via preload). */
export function pathForFile(file: File): string {
  return window.hmlFiles.getPathForFile(file)
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
