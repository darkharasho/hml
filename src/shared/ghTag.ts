import { compareVersions } from './version'

/**
 * Monorepo release tags: a repo that publishes several mods tags each release with the mod's
 * name before its version (`infinite-energy-v0.1.0`, `faerie-flight/1.2`, `@scope/pkg@2.0.0`).
 * The name part is the tag's prefix; HML follows a mod's prefix so another mod's release in the
 * same repo is never taken for an update. Plain version tags (`v1.2.3`, `1.0-hotfix-2`) have none.
 */

const PREFIXED = /^(.+?)[-_/@]v?\d/i

/** The mod name part of a tag before its version, else ''. */
export function tagPrefix(tag: string): string {
  const m = PREFIXED.exec(tag)
  if (!m) return ''
  // A tag that starts with its version (`v1.0-rc-2`) has no prefix.
  return /^v?\d/i.test(m[1]) ? '' : m[1]
}

/** The version part of a tag: without its prefix, the separator and a leading `v`. */
export function tagVersion(tag: string): string {
  const prefix = tagPrefix(tag)
  return (prefix ? tag.slice(prefix.length + 1) : tag).replace(/^v/i, '')
}

/**
 * A catalog manifest's `tagPrefix` as tagPrefix() gives it from a tag: manifests may include the
 * separator and `v` (`a-v`), which tagPrefix() strips.
 */
export function normPrefix(p: string): string {
  return p.replace(/[-_/@]v?$/i, '') || p
}

/** True when two prefixes name the same mod (GitHub tags are case-sensitive, names aren't). */
export const samePrefix = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** The installed id of a GitHub mod: `owner-repo`, plus the tag prefix in a monorepo. */
export function ghPackageId(owner: string, repo: string, prefix: string): string {
  if (!prefix) return `${owner}-${repo}`
  return `${owner}-${repo}-${prefix.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')}`
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * What `{version}` matches: version-like text such as `5.4.23.5`, `v1.2`, `r42` or `1.0.0-beta.2`,
 * with an optional one-letter prefix and pre-release suffix, but not arbitrary text like `-debug`.
 */
const VERSION_SRC = '[a-z]?\\d+(?:[._-]\\d+)*(?:[._-]?(?:alpha|beta|rc|pre|preview)[._-]?\\d*)?'

/**
 * Most `{version}` tokens a pattern may hold (hml.json enforces the same). Adjacent tokens
 * backtrack against each other, exponentially in their count, so a longer pattern never matches.
 */
export const MAX_PATTERN_TOKENS = 2

/**
 * True when two `{version}` tokens touch (`{version}{version}`). With no text between them they
 * can split the same digits many ways, so matching a long name backtracks far more.
 */
export const hasAdjacentTokens = (pattern: string): boolean =>
  pattern.includes('{version}{version}')

/**
 * Longest asset name a pattern matches. Matching time grows with the name's length squared
 * (about 42 ms per 300 names at 250 characters, 2.6 ms at 64), so longer names never match.
 */
export const MAX_ASSET_NAME_LENGTH = 100

/** A matcher for one pattern, compiled once (for matching many names). */
export function assetMatcher(pattern: string): (name: string) => boolean {
  const parts = pattern.split('{version}')
  if (parts.length - 1 > MAX_PATTERN_TOKENS || hasAdjacentTokens(pattern)) return () => false
  const re = new RegExp(`^${parts.map(escapeRegExp).join(VERSION_SRC)}$`, 'i')
  return (name) => name.length <= MAX_ASSET_NAME_LENGTH && re.test(name)
}

export function matchesAssetPattern(pattern: string, name: string): boolean {
  return assetMatcher(pattern)(name)
}

const VERSION_LIKE = /^v?\d+(\.\d+)*$/i

/** Two tags of one monorepo mod as their versions; other tags unchanged. */
export function versionsOf(a: string, b: string): [string, string] {
  const pa = tagPrefix(a)
  return pa && samePrefix(pa, tagPrefix(b)) ? [tagVersion(a), tagVersion(b)] : [a, b]
}

/** True when `latestTag` is newer: version-like tags compare numerically, others when they differ. */
export function isNewerTag(latestTag: string, currentTag: string): boolean {
  const [latest, current] = versionsOf(latestTag, currentTag)
  if (VERSION_LIKE.test(latest) && VERSION_LIKE.test(current)) {
    const strip = (t: string): string => t.replace(/^v/i, '')
    return compareVersions(strip(latest), strip(current)) > 0
  }
  return latest !== current
}
