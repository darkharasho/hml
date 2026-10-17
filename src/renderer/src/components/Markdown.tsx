import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useMemo } from 'react'
import { api } from '../api'
import { useStore } from '../store'

// Mod READMEs are untrusted: no styles, forms or embeds survive, images load lazily without a
// referrer, and links never navigate the window (clicks go through openExternal below).
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'IMG') {
    node.setAttribute('loading', 'lazy')
    node.setAttribute('referrerpolicy', 'no-referrer')
  }
})

function toHtml(markdown: string): string {
  const html = marked.parse(markdown, { async: false, gfm: true })
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe'],
    FORBID_ATTR: ['style', 'class', 'id']
  })
}

/** Renders a mod's README or changelog markdown, sanitized, with links opened outside the app. */
export function Markdown({ source }: { source: string }): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const html = useMemo(() => toHtml(source), [source])

  function onClick(e: React.MouseEvent<HTMLDivElement>): void {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href') ?? ''
    if (!/^https?:\/\//i.test(href)) return
    api.openExternal(href).catch(() => {
      // Only Thunderstore, GitHub and Nexus links open directly; copy anything else.
      navigator.clipboard.writeText(href).then(
        () => toast('info', 'HML only opens Thunderstore, GitHub and Nexus links. Copied it.'),
        () => toast('error', 'HML only opens Thunderstore, GitHub and Nexus links.')
      )
    })
  }

  return (
    <div className="md select-text" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
  )
}
