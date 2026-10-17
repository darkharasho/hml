import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode
} from 'react'

type Variant = 'primary' | 'ghost' | 'quiet' | 'danger'

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-ember text-ink font-semibold hover:bg-[#ffab5c] active:bg-ember-deep disabled:bg-raised disabled:text-muted',
  ghost: 'border border-line text-fg hover:bg-raised hover:border-[#3a5664] disabled:text-muted',
  quiet: 'text-muted hover:text-fg hover:bg-raised disabled:opacity-50',
  danger: 'bg-danger text-ink font-semibold hover:bg-[#ff7884] disabled:opacity-50'
}

export function Button({
  variant = 'ghost',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }): React.JSX.Element {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-md px-3 h-9 text-sm transition-colors disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  )
}

/** Centered modal using the native <dialog>, so focus trapping and Escape come for free. */
export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 'w-[440px]'
}: {
  title: string
  onClose(): void
  children: ReactNode
  footer?: ReactNode
  width?: string
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
      className={`${width} max-w-[calc(100vw-2rem)] m-auto rounded-xl border border-line bg-panel text-fg p-0 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.7)] backdrop:bg-[#061014]/70 backdrop:backdrop-blur-[2px] [animation:dialog-in_160ms_ease-out]`}
    >
      <div className="px-5 pt-5 pb-4">
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        <div className="mt-3 text-sm text-muted">{children}</div>
      </div>
      {footer && (
        <div className="flex justify-end gap-2 border-t border-line bg-ink/40 px-5 py-3">
          {footer}
        </div>
      )}
    </dialog>
  )
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose
}: {
  title: string
  body: ReactNode
  confirmLabel: string
  onConfirm(): void
  onClose(): void
}): React.JSX.Element {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              onConfirm()
              onClose()
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body}
    </Modal>
  )
}

const ICONS = {
  search:
    'M11 4a7 7 0 1 0 4.2 12.6l4.1 4.1 1.4-1.4-4.1-4.1A7 7 0 0 0 11 4Zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z',
  gear: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87a.47.47 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.47.47 0 0 0-.12-.61l-2.01-1.58ZM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2Z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z',
  dots: 'M12 7.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm0 6a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm0 6a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z',
  play: 'M8 5.5v13a.5.5 0 0 0 .8.4l10-6.5a.5.5 0 0 0 0-.8l-10-6.5a.5.5 0 0 0-.8.4Z',
  folder: 'M3 6a2 2 0 0 1 2-2h4.6l2 2H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z',
  upload: 'M12 3 6.5 8.5l1.4 1.4L11 6.8V16h2V6.8l3.1 3.1 1.4-1.4L12 3ZM4 18h16v2H4v-2Z',
  grid: 'M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z',
  warn: 'M12 3 1.5 21h21L12 3Zm-1 6h2v6h-2V9Zm0 8h2v2h-2v-2Z',
  close:
    'm6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4 6.4 5Z',
  copy: 'M8 3h11a2 2 0 0 1 2 2v11h-2V5H8V3ZM5 7h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z',
  download: 'M11 3h2v9.2l3.1-3.1 1.4 1.4L12 16l-5.5-5.5 1.4-1.4 3.1 3.1V3ZM4 18h16v2H4v-2Z',
  thumb:
    'M2 10h4v11H2V10Zm6 11V9.6l4.6-6.9a1.5 1.5 0 0 1 2.7 1.1L14.4 9H20a2 2 0 0 1 2 2.3l-1.3 8A2 2 0 0 1 18.7 21H8Z',
  external:
    'M14 3h7v7h-2V6.4l-8.3 8.3-1.4-1.4L17.6 5H14V3ZM5 5h6v2H5v12h12v-6h2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z',
  check: 'm9.5 16.2-4.2-4.2-1.4 1.4 5.6 5.6 11.4-11.4-1.4-1.4-10 10Z',
  github:
    'M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.33c-2.22.48-2.69-1.07-2.69-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.71 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.77-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0Z',
  refresh:
    'M12 4a8 8 0 0 1 7.4 5H17v2h6V5h-2v2.3A10 10 0 0 0 2 12h2a8 8 0 0 1 8-8Zm8 8a8 8 0 0 1-15.4 3H7v-2H1v6h2v-2.3A10 10 0 0 0 22 12h-2Z'
} as const

export type IconName = keyof typeof ICONS

/** Icons drawn on a grid other than the default 24×24. */
const VIEWBOX: Partial<Record<IconName, string>> = { github: '0 0 16 16' }

export function Icon({
  name,
  className = 'size-4'
}: {
  name: IconName
  className?: string
}): React.JSX.Element {
  return (
    <svg
      viewBox={VIEWBOX[name] ?? '0 0 24 24'}
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path fillRule="evenodd" d={ICONS[name]} />
    </svg>
  )
}

export interface MenuItem {
  label: string
  onSelect(): void
  danger?: boolean
  /** Set (true or false) to make this a radio-style item; true shows a check mark. */
  checked?: boolean
  /** With `checked`, an on/off item (a checkbox) instead of one of a radio group. */
  toggle?: boolean
  /** Draws a divider above the item to start a new group. */
  divider?: boolean
}

/** A small popover menu anchored to a trigger; closes on outside click or Escape. */
export function Menu({
  label,
  items,
  className = '',
  position = 'relative'
}: {
  label: string
  items: MenuItem[]
  className?: string
  /** Tailwind position class for the trigger; an absolute one is still the dropdown's anchor. */
  position?: string
}): React.JSX.Element {
  const [up, setUp] = useState(false)
  const [alignLeft, setAlignLeft] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const hasChecks = items.some((i) => i.checked !== undefined)
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const close = (e: Event): void => {
      const el = ref.current
      if (!el?.open) return
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !el.contains(e.target as Node))
        el.open = false
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [])
  return (
    <details
      ref={ref}
      className={`${position} ${className}`}
      onToggle={(e) => {
        // Open upward when the trigger sits in the lower part of the viewport, so the last
        // rows of a scrolling list don't clip the dropdown.
        if (e.currentTarget.open) {
          const r = e.currentTarget.getBoundingClientRect()
          setUp(r.bottom > window.innerHeight * 0.6)
          // A wide menu near the window's left edge opens rightward instead of being clipped.
          const menuWidth = menuRef.current?.offsetWidth ?? 0
          setAlignLeft(r.right - menuWidth < 0)
        }
      }}
    >
      <summary
        aria-label={label}
        title={label}
        className="grid size-8 cursor-pointer list-none place-items-center rounded-md text-muted hover:bg-raised hover:text-fg [&::-webkit-details-marker]:hidden"
      >
        <Icon name="dots" />
      </summary>
      <div
        ref={menuRef}
        role="menu"
        className={`absolute ${alignLeft ? 'left-0' : 'right-0'} z-20 min-w-40 overflow-hidden whitespace-nowrap rounded-lg border border-line bg-raised py-1 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.6)] ${
          up ? 'bottom-full mb-1' : 'mt-1'
        }`}
      >
        {items.map((item) => (
          <Fragment key={item.label}>
            {item.divider && <div role="separator" className="my-1 h-px bg-line" />}
            <button
              type="button"
              role={
                item.checked === undefined
                  ? 'menuitem'
                  : item.toggle
                    ? 'menuitemcheckbox'
                    : 'menuitemradio'
              }
              aria-checked={item.checked}
              onClick={() => {
                if (ref.current) ref.current.open = false
                item.onSelect()
              }}
              className={`flex w-full items-center gap-2 py-1.5 pr-4 text-left text-sm hover:bg-line/60 ${
                hasChecks ? 'pl-2' : 'pl-3'
              } ${item.danger ? 'text-danger' : 'text-fg'}`}
            >
              {hasChecks && (
                <span className="grid size-4 shrink-0 place-items-center text-ember">
                  {item.checked && <Icon name="check" className="size-3.5" />}
                </span>
              )}
              {item.label}
            </button>
          </Fragment>
        ))}
      </div>
    </details>
  )
}
