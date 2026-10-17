/** A game's accent colour as CSS variables, and the copy remembered between launches. */
export const ACCENT = /^#[0-9a-f]{6}$/i
export const storageKey = (label: string): string => `hml.accent.${label}`

/** The CSS variables that recolour the app's accent (Tailwind's `ember`) to `accent`. */
export function accentVars(accent: string): Record<string, string> {
  return {
    '--color-ember': accent,
    '--color-ember-hover': `color-mix(in oklab, ${accent} 82%, white)`,
    '--color-ember-deep': `color-mix(in oklab, ${accent} 80%, black)`
  }
}

/** The accent remembered for a game, so it shows at once next time; null if none or invalid. */
export function rememberedAccent(storage: Pick<Storage, 'getItem'>, label: string): string | null {
  try {
    const v = storage.getItem(storageKey(label))
    return v && ACCENT.test(v) ? v : null
  } catch {
    return null
  }
}
