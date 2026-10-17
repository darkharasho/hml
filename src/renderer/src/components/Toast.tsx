import { useStore, type ToastKind } from '../store'
import { Icon } from './ui'

const ACCENT: Record<ToastKind, string> = {
  error: 'bg-danger',
  success: 'bg-teal',
  info: 'bg-ember'
}

export function Toasts(): React.JSX.Element {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  return (
    <div
      aria-live="polite"
      data-inert-under-modal
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          className="pointer-events-auto flex items-start gap-3 overflow-hidden rounded-lg border border-line bg-raised py-2.5 pr-2 pl-0 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.7)] [animation:toast-in_180ms_ease-out]"
        >
          <span className={`w-1 self-stretch ${ACCENT[t.kind]}`} />
          <p className="flex-1 py-0.5 text-sm text-fg select-text">{t.message}</p>
          {t.action && (
            <button
              type="button"
              onClick={() => {
                t.action?.run()
                dismiss(t.id)
              }}
              className="h-6 shrink-0 rounded px-2 text-sm font-medium text-ember hover:bg-line/60"
            >
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismiss(t.id)}
            className="grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-line/60 hover:text-fg"
          >
            <Icon name="close" className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
