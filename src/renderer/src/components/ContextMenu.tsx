import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { setContextMenuHandler, type ContextMenuState as Open } from '../contextMenu'
import { MENU_PANEL, MenuRows, type MenuItem } from './ui'

// Inputs that hold editable text; checkboxes, buttons and the like get no edit menu.
const TEXT_INPUTS = new Set(['', 'text', 'search', 'url', 'email', 'password', 'number', 'tel'])

function textField(target: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (target instanceof HTMLTextAreaElement) return target
  if (target instanceof HTMLInputElement && TEXT_INPUTS.has(target.getAttribute('type') ?? ''))
    return target
  return null
}

function fieldHasSelection(field: HTMLInputElement | HTMLTextAreaElement): boolean {
  try {
    return field.selectionStart !== field.selectionEnd
  } catch {
    // Number fields have no selection API; treat their text as copyable.
    return field.value !== ''
  }
}

/** Cut/Copy/Paste/Select all for a text field, or Copy for selected page text; null for neither. */
function editItems(target: EventTarget | null): MenuItem[] | null {
  const run = (cmd: 'cut' | 'copy' | 'paste' | 'selectAll') => () => void window.hmlWindow[cmd]()
  const field = textField(target)
  if (field) {
    const writable = !field.readOnly && !field.disabled
    const selected = fieldHasSelection(field)
    // A password can be typed or pasted over, but not read back out.
    const secret = field instanceof HTMLInputElement && field.type === 'password'
    return [
      { label: 'Cut', disabled: !writable || !selected || secret, onSelect: run('cut') },
      { label: 'Copy', disabled: !selected || secret, onSelect: run('copy') },
      { label: 'Paste', disabled: !writable, onSelect: run('paste') },
      {
        label: 'Select all',
        divider: true,
        disabled: field.value === '',
        onSelect: run('selectAll')
      }
    ]
  }
  if (window.getSelection()?.toString()) return [{ label: 'Copy', onSelect: run('copy') }]
  return null
}

/** Draws the right-click menu. Mounted once, beside the app. */
export function ContextMenuHost(): React.JSX.Element | null {
  const [menu, setMenu] = useState<Open | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setContextMenuHandler((m) => {
      setPos(null)
      setMenu(m)
    })
    // Runs after React's handlers, so a component's own menu (openContextMenu) wins.
    const onContextMenu = (e: MouseEvent): void => {
      if (e.defaultPrevented) return
      e.preventDefault()
      const items = editItems(e.target)
      setPos(null)
      setMenu(items ? { x: e.clientX, y: e.clientY, items, keepFocus: true } : null)
    }
    document.addEventListener('contextmenu', onContextMenu)
    return () => {
      setContextMenuHandler(null)
      document.removeEventListener('contextmenu', onContextMenu)
    }
  }, [])

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      close()
    }
    document.addEventListener('mousedown', onDown)
    // Capture, so Escape closes the menu instead of a dialog under it.
    document.addEventListener('keydown', onKey, true)
    // Scrolling or resizing would leave it pointing at the wrong thing.
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  // Opens at the pointer, flipped left or up where it would run off the window.
  useLayoutEffect(() => {
    const el = ref.current
    if (!menu || !el) return
    const { offsetWidth: w, offsetHeight: h } = el
    const left = menu.x + w > window.innerWidth ? Math.max(0, menu.x - w) : menu.x
    const top = menu.y + h > window.innerHeight ? Math.max(0, menu.y - h) : menu.y
    setPos({ left, top })
  }, [menu])

  if (!menu) return null
  return createPortal(
    <div
      ref={ref}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      style={pos ?? { left: menu.x, top: menu.y, visibility: 'hidden' }}
      className={`fixed z-[70] ${MENU_PANEL}`}
    >
      <MenuRows items={menu.items} keepFocus={menu.keepFocus} onPick={() => setMenu(null)} />
    </div>,
    document.body
  )
}
