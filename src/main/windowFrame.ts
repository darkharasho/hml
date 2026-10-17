import type { BrowserWindowConstructorOptions } from 'electron'
import type { WindowApi } from '../shared/ipc'

/** Height of the titlebar the renderer draws (keep in step with TitleBar.tsx). */
export const TITLEBAR_HEIGHT = 38

/**
 * Frame options for HML's own titlebar. macOS keeps its traffic lights, centered in the bar;
 * Windows and Linux get no system frame or overlay, and the renderer draws the window buttons.
 * `frame: false` is left out on purpose: with only a hidden title bar, a double-click on the
 * drag region still maximizes and restores natively (checked on Linux X11). The page never sees
 * clicks on a drag region, so it couldn't do that itself.
 */
export function titlebarOptions(platform: NodeJS.Platform): BrowserWindowConstructorOptions {
  if (platform === 'darwin') {
    // The lights are 12px tall (with a 2px inset), so this centers them in the bar.
    return { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: TITLEBAR_HEIGHT / 2 - 7 } }
  }
  return { titleBarStyle: 'hidden' }
}

/** The subset of BrowserWindow the controls use. */
export interface ControllableWindow {
  minimize(): void
  maximize(): void
  unmaximize(): void
  isMaximized(): boolean
  close(): void
}

export function windowControls(win: ControllableWindow): {
  [K in keyof WindowApi]: () => Awaited<ReturnType<WindowApi[K]>>
} {
  return {
    minimize: () => win.minimize(),
    toggleMaximize: () => (win.isMaximized() ? win.unmaximize() : win.maximize()),
    close: () => win.close(),
    isMaximized: () => win.isMaximized()
  }
}
