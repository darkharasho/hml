import { test, expect } from 'vitest'
import { channel } from '../../src/shared/ipc'
test('channel names are namespaced', () => {
  expect(channel('ping')).toBe('hml:ping')
})
