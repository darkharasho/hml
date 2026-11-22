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

export function matchesAssetPattern(pattern: string, name: string): boolean {
  const src = pattern.split('{version}').map(escapeRegExp).join(VERSION_SRC)
  return new RegExp(`^${src}$`, 'i').test(name)
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
