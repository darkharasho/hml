export interface GhRef {
  owner: string
  repo: string
  tag?: string
  asset?: string
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

function decodeAll(segs: string[]): string | null {
  const out = segs.map(decode)
  return out.every((x) => x !== null) ? out.join('/') : null
}

export function parseGithubUrl(input: string): GhRef | null {
  const trimmed = input.trim().replace(/[?#].*$/, '')
  const hasScheme = /^https?:\/\//i.test(trimmed)
  const parts = trimmed
    .replace(/^https?:\/\//i, '')
    .split('/')
    .filter((x) => x !== '')
  if (/^(www\.)?github\.com$/i.test(parts[0] ?? '')) parts.shift()
  else if (hasScheme || parts.length !== 2) return null // other host, or not bare owner/repo
  if (parts.length < 2) return null
  const owner = parts[0]
  const repo = parts[1].replace(/\.git$/i, '')
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') return null
  const ref: GhRef = { owner, repo }
  const rest = parts.slice(2)
  if (rest[0] === 'releases' && rest[1] === 'tag' && rest.length > 2) {
    const tag = decodeAll(rest.slice(2))
    if (tag !== null) ref.tag = tag
  } else if (rest[0] === 'releases' && rest[1] === 'download' && rest.length > 3) {
    const tag = decodeAll(rest.slice(2, -1))
    const asset = decode(rest[rest.length - 1])
    if (tag !== null && asset !== null) {
      ref.tag = tag
      ref.asset = asset
    }
  }
  return ref
}
