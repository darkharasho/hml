/// <reference types="vite/client" />
import type { HmlApi } from '../../shared/ipc'
import type { HmlEvent } from '../../shared/types'

declare global {
  interface Window {
    hml: HmlApi
    hmlEvents: { on(cb: (e: HmlEvent) => void): () => void }
    /** `process.platform` of the main process, from the preload. */
    hmlPlatform?: string
    hmlFiles: { getPathForFile(file: File): string }
  }
}
