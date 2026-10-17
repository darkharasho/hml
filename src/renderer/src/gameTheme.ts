import { useLayoutEffect } from 'react'
import { api } from './api'
import { ACCENT, accentVars, rememberedAccent, storageKey } from './accentView'

function apply(accent: string | null): void {
  const root = document.documentElement
  for (const [k, v] of Object.entries(accentVars(accent ?? '#000000'))) {
    if (accent) root.style.setProperty(k, v)
    else root.style.removeProperty(k)
  }
  if (accent) root.dataset.gameColors = ''
  else delete root.dataset.gameColors
}

/**
 * Recolours the app's accent to the open game's colour (taken from its cover) while `enabled`.
 * The remembered colour shows at once; a fresh one replaces it when main answers. With no game,
 * or a game too grey to take a colour from, the stock orange stays.
 */
export function useGameAccent(label: string | null, enabled: boolean): void {
  useLayoutEffect(() => {
    if (!label || !enabled) {
      apply(null)
      return
    }
    let live = true
    apply(rememberedAccent(localStorage, label))
    api.getGameAccent(label).then(
      (accent) => {
        if (!live) return
        const valid = accent && ACCENT.test(accent) ? accent : null
        try {
          if (valid) localStorage.setItem(storageKey(label), valid)
          else localStorage.removeItem(storageKey(label))
        } catch {
          // Without storage the colour just isn't remembered.
        }
        apply(valid)
      },
      () => undefined
    )
    return () => {
      live = false
      apply(null)
    }
  }, [label, enabled])
}
