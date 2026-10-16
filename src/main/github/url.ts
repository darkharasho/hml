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

export function parseGithubUrl(input: string): GhRef | null {
  const s = input
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/^https?:\/\//i, '')
  const parts = s.split('/').filter((x) => x !== '')
  // Owners can't contain dots, so any other host fails the owner check below.
  if (/^(www\.)?github\.com$/i.test(parts[0] ?? '')) parts.shift()
  if (parts.length < 2) return null
  const owner = parts[0]
  const repo = parts[1].replace(/\.git$/i, '')
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') return null
  const ref: GhRef = { owner, repo }
  const rest = parts.slice(2)
  if (rest[0] === 'releases' && rest[1] === 'tag' && rest[2]) {
    const tag = decode(rest[2])
    if (tag !== null) ref.tag = tag
  } else if (rest[0] === 'releases' && rest[1] === 'download' && rest[2] && rest[3]) {
    const tag = decode(rest[2])
    const asset = decode(rest[3])
    if (tag !== null && asset !== null) {
      ref.tag = tag
      ref.asset = asset
    }
  }
  return ref
}
