import type { MenuItem } from './components/ui'

export interface ContextMenuState {
  x: number
  y: number
  items: MenuItem[]
  /** Edit commands keep focus in the text field they act on. */
  keepFocus: boolean
}

let show: ((menu: ContextMenuState) => void) | null = null

/** ContextMenuHost registers how it shows a menu; null when it unmounts. */
export function setContextMenuHandler(handler: typeof show): void {
  show = handler
}

/**
 * Opens HML's right-click menu with these items at the pointer. Call it from an onContextMenu
 * handler; text fields and selected text get Cut/Copy/Paste on their own.
 */
export function openContextMenu(e: React.MouseEvent, items: MenuItem[]): void {
  e.preventDefault()
  show?.({ x: e.clientX, y: e.clientY, items, keepFocus: false })
}
