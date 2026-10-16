/// <reference types="vite/client" />
import type { HmlApi } from '../../shared/ipc'

declare global {
  interface Window {
    hml: HmlApi
  }
}
