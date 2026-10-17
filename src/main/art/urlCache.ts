import { readJson, writeJsonAtomic } from '../store/json'

/** A looked-up image URL (null: the source had none) and when it was looked up (ms). */
export interface CachedUrl {
  url: string | null
  at: number
}

/**
 * An in-memory map of looked-up URLs, loaded once from `file` and saved back after changes.
 * Saves run one after another and each writes the whole map as it is then, so concurrent lookups
 * can't overwrite each other's entries. Read and write failures are ignored.
 */
export function createUrlCache(
  file: string,
  validKey: (key: string) => boolean
): { load(): Promise<Map<string, CachedUrl>>; save(): Promise<void> } {
  let loaded: Promise<Map<string, CachedUrl>> | null = null
  let saving: Promise<void> = Promise.resolve()
  const load = (): Promise<Map<string, CachedUrl>> => {
    loaded ??= readJson<Record<string, CachedUrl>>(file)
      .catch(() => null)
      .then((j) => {
        const m = new Map<string, CachedUrl>()
        for (const [k, v] of Object.entries(j && typeof j === 'object' ? j : {})) {
          if (validKey(k) && v && typeof v.at === 'number') {
            m.set(k, { url: typeof v.url === 'string' ? v.url : null, at: v.at })
          }
        }
        return m
      })
    return loaded
  }
  return {
    load,
    save() {
      saving = saving.then(async () =>
        writeJsonAtomic(file, Object.fromEntries(await load()), { pretty: false }).catch(
          () => undefined
        )
      )
      return saving
    }
  }
}
