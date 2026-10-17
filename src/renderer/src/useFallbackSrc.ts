import { useState } from 'react'

/**
 * The first of `urls` that hasn't failed to load, and the img onError that moves on to the next.
 * Null once every URL failed (or there were none), for the caller's letter fallback. A new list
 * starts over from its first URL.
 */
export function useFallbackSrc(urls: readonly (string | null | undefined)[]): {
  src: string | null
  onError(): void
} {
  const list = urls.filter((u): u is string => !!u)
  const key = list.join('\n')
  const [failed, setFailed] = useState({ key, count: 0 })
  const count = failed.key === key ? failed.count : 0
  return { src: list[count] ?? null, onError: () => setFailed({ key, count: count + 1 }) }
}
