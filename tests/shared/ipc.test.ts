import { test, expect } from 'vitest'
import { HML_METHODS, channel, stripIpcErrorPrefix } from '../../src/shared/ipc'
test('channel names are namespaced', () => {
  expect(channel('launch')).toBe('hml:launch')
})
test('stripIpcErrorPrefix removes the Electron wrapper only', () => {
  expect(
    stripIpcErrorPrefix("Error invoking remote method 'hml:launch': Error: Steam not found")
  ).toBe('Steam not found')
  expect(stripIpcErrorPrefix('Plain message')).toBe('Plain message')
})
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
test('HML_METHODS lists the github methods', () => {
  expect(HML_METHODS).toEqual(
    expect.arrayContaining([
      'ghInstall',
      'ghCheckUpdates',
      'ghUpdate',
      'ghSetUpdateMode',
      'ghSetToken',
      'ghTokenStatus'
    ])
  )
  expect(HML_METHODS).not.toContain('ghAutoUpdateAll')
})
test('HML_METHODS lists the nexus game methods', () => {
  expect(HML_METHODS).toEqual(
    expect.arrayContaining(['addNexusGame', 'nxGetDomain', 'nxSetDomain'])
  )
})
test('HML_METHODS lists the deployment methods', () => {
  expect(HML_METHODS).toEqual(
    expect.arrayContaining(['deployProfile', 'removeDeployment', 'getDeployment'])
  )
})
test('HML_METHODS lists the nexus methods', () => {
  expect(HML_METHODS).toEqual(
    expect.arrayContaining([
      'nxSetKey',
      'nxStatus',
      'nxRegisterHandler',
      'nxSearch',
      'nxGetMod',
      'nxInstall',
      'nxCheckUpdates',
      'nxUpdate'
    ])
  )
  expect(HML_METHODS).not.toContain('installFromNxm')
})
test('HML_METHODS lists the share methods', () => {
  expect(HML_METHODS).toEqual(expect.arrayContaining(['exportProfileFile', 'shareProfile']))
})
test('HML_METHODS lists the custom game methods', () => {
  expect(HML_METHODS).toEqual(
    expect.arrayContaining([
      'detectCustomGame',
      'pickCustomGameFolder',
      'addCustomGame',
      'updateCustomGame',
      'removeCustomGame',
      'listRunners'
    ])
  )
})
