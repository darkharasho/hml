import { test, expect } from 'vitest'
import { channel, stripIpcErrorPrefix } from '../../src/shared/ipc'
test('channel names are namespaced', () => {
  expect(channel('launch')).toBe('hml:launch')
})
test('stripIpcErrorPrefix removes the Electron wrapper only', () => {
  expect(
    stripIpcErrorPrefix("Error invoking remote method 'hml:launch': Error: Steam not found")
  ).toBe('Steam not found')
  expect(stripIpcErrorPrefix('Plain message')).toBe('Plain message')
})
import { HML_METHODS } from '../../src/shared/ipc'
test('HML_METHODS lists the thunderstore methods', () => {
  expect(HML_METHODS).toEqual(
    expect.arrayContaining([
      'tsSearch',
      'tsRefresh',
      'tsGetPackage',
      'tsInstall',
      'tsCheckUpdates',
      'tsUpdate',
      'openExternal'
    ])
  )
})
