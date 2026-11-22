// Pure: blocklist resolution that survives renames by tracking GitHub ids.
// No node:* or Electron imports (bundled into the Worker).
import type { BlockEntry, ServedBlocklist } from '../../../src/shared/ghCatalog'
import type { CrawledRepo } from './listing'

export interface BlockState {
  /** Keys are `owner:<ownerNodeId>` or `repo:<databaseId>`. `target` is the lowercase entry that created it. */
  ids: Record<string, { kind: 'owner' | 'repo'; reason: string; names: string[]; target?: string }>
}

const kindOf = (target: string): 'owner' | 'repo' => (target.includes('/') ? 'repo' : 'owner')
const keyFor = (kind: 'owner' | 'repo', r: CrawledRepo): string =>
  kind === 'repo' ? `repo:${r.id}` : `owner:${r.ownerId}`
const nameFor = (kind: 'owner' | 'repo', r: CrawledRepo): string =>
  (kind === 'repo' ? `${r.owner}/${r.repo}` : r.owner).toLowerCase()
const nameMatches = (target: string, r: CrawledRepo): boolean =>
  target === r.owner.toLowerCase() || target === `${r.owner}/${r.repo}`.toLowerCase()

export function updateBlockState(
  entries: BlockEntry[],
  state: BlockState,
  seen: CrawledRepo[]
): BlockState {
  const targets = new Map(entries.map((e) => [e.target.toLowerCase(), e]))
  const ids: BlockState['ids'] = {}
  for (const [key, v] of Object.entries(state.ids)) {
    const e = v.target !== undefined ? targets.get(v.target) : undefined
    if (e) ids[key] = { ...v, reason: e.reason, names: [...v.names] }
  }
  for (const [target, e] of targets) {
    const kind = kindOf(target)
    for (const r of seen) {
      const key = keyFor(kind, r)
      const known = ids[key]?.target === target
      if (!known && !nameMatches(target, r)) continue
      const name = nameFor(kind, r)
      const cur = ids[key]
      if (cur && cur.target === target) {
        if (!cur.names.includes(name)) cur.names.push(name)
      } else {
        ids[key] = { kind, reason: e.reason, names: [name], target }
      }
    }
  }
  return { ids }
}

export function isBlocked(r: CrawledRepo, entries: BlockEntry[], state: BlockState): string | null {
  for (const e of entries) {
    const target = e.target.toLowerCase()
    if (nameMatches(target, r)) return e.reason
    const hit = state.ids[keyFor(kindOf(target), r)]
    if (hit && hit.target === target) return e.reason
  }
  return null
}

export function serveBlocklist(entries: BlockEntry[], state: BlockState): ServedBlocklist {
  return {
    entries: entries.map((e) => {
      const target = e.target.toLowerCase()
      const names = new Set([target])
      for (const v of Object.values(state.ids)) {
        if (v.target === target) for (const n of v.names) names.add(n)
      }
      return { names: [...names], reason: e.reason }
    })
  }
}
