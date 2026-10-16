import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { resolveSnapshotPath } from '../../src/main/snapshotPath'

describe('resolveSnapshotPath', () => {
  test('packaged: next to app.asar in the resources dir (electron-builder extraResources)', () => {
    expect(
      resolveSnapshotPath({
        isPackaged: true,
        resourcesPath: '/opt/HML/resources',
        devPath: '/opt/HML/resources/app.asar/resources/ecosystem-snapshot.json'
      })
    ).toBe(path.join('/opt/HML/resources', 'ecosystem-snapshot.json'))
  })

  test('dev: the bundler-resolved project path', () => {
    expect(
      resolveSnapshotPath({
        isPackaged: false,
        resourcesPath: '/usr/lib/electron/resources',
        devPath: '/src/hml/resources/ecosystem-snapshot.json'
      })
    ).toBe('/src/hml/resources/ecosystem-snapshot.json')
  })
})
