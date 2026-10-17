/// <reference types="vite/client" />
import type { HmlApi, UpdateApi, UpdateState, WindowApi } from '../../shared/ipc'
import type { HmlEvent } from '../../shared/types'

declare global {
  interface Window {
    hml: HmlApi
    hmlEvents: { on(cb: (e: HmlEvent) => void): () => void }
    /** `process.platform` of the main process, from the preload. */
    hmlPlatform?: string
    hmlFiles: { getPathForFile(file: File): string }
    hmlWindow: WindowApi & { onMaximizedChange(cb: (maximized: boolean) => void): () => void }
    hmlUpdate: UpdateApi & { onState(cb: (state: UpdateState) => void): () => void }
  }
}
