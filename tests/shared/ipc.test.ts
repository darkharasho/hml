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
