import { describe, expect, test } from 'vitest'
import { ghPackageId, samePrefix, tagPrefix, tagVersion } from '../../src/shared/ghTag'

describe('tagPrefix', () => {
  test.each([
    ['infinite-energy-v0.1.0', 'infinite-energy'],
    ['faerie-flight-v0.2.6', 'faerie-flight'],
    ['InfiniteEnergy-0.1.0', 'InfiniteEnergy'],
    ['my_mod_1.2', 'my_mod'],
    ['faerie-flight/v1.2', 'faerie-flight'],
    ['@scope/pkg@2.0.0', '@scope/pkg'],
    ['v1.2.3', ''],
    ['1.2.3', ''],
    ['v1.0-rc-2', ''],
    ['1.0-hotfix-2', ''],
    ['r5', ''],
    ['nightly', '']
  ])('%s -> %s', (tag, prefix) => {
    expect(tagPrefix(tag)).toBe(prefix)
  })
})

describe('tagVersion', () => {
  test.each([
    ['infinite-energy-v0.1.0', '0.1.0'],
    ['InfiniteEnergy-0.1.0', '0.1.0'],
    ['@scope/pkg@2.0.0-beta.1', '2.0.0-beta.1'],
    ['v1.2.3', '1.2.3'],
    ['nightly', 'nightly']
  ])('%s -> %s', (tag, version) => {
    expect(tagVersion(tag)).toBe(version)
  })
})

test('samePrefix ignores case', () => {
  expect(samePrefix('Infinite-Energy', 'infinite-energy')).toBe(true)
  expect(samePrefix('infinite-energy', 'faerie-flight')).toBe(false)
})

test('ghPackageId adds a safe prefix only in a monorepo', () => {
  expect(ghPackageId('owner', 'repo', '')).toBe('owner-repo')
  expect(ghPackageId('owner', 'repo', 'infinite-energy')).toBe('owner-repo-infinite-energy')
  expect(ghPackageId('owner', 'repo', '@scope/pkg')).toBe('owner-repo-scope-pkg')
})
