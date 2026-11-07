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

/** True when two prefixes name the same mod (GitHub tags are case-sensitive, names aren't). */
export const samePrefix = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** The installed id of a GitHub mod: `owner-repo`, plus the tag prefix in a monorepo. */
export function ghPackageId(owner: string, repo: string, prefix: string): string {
  if (!prefix) return `${owner}-${repo}`
  return `${owner}-${repo}-${prefix.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')}`
}
