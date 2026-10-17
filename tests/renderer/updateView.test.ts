import { describe, expect, test } from 'vitest'
import { updatePill, updateStatusText } from '../../src/renderer/src/updateView'

describe('updatePill', () => {
  test.each([
    { status: 'idle' },
    { status: 'checking' },
    { status: 'none' },
    { status: 'error', message: 'offline' }
  ] as const)('hidden for $status', (state) => {
    expect(updatePill(state)).toBeNull()
  })

  test('shows the download percentage, rounded', () => {
    expect(updatePill({ status: 'downloading', version: '1.1.0', percent: 41.6 })).toEqual({
      kind: 'downloading',
      label: 'Downloading 42%'
    })
    expect(updatePill({ status: 'downloading', version: '1.1.0', percent: null })).toEqual({
      kind: 'downloading',
      label: 'Downloading…'
    })
  })

  test('offers a restart once downloaded', () => {
    expect(updatePill({ status: 'downloaded', version: '1.1.0' })).toEqual({
      kind: 'restart',
      label: 'Restart to update',
      version: '1.1.0'
    })
  })
})

describe('updateStatusText', () => {
  test('nothing before the user asks, unless an update is under way', () => {
    expect(updateStatusText({ status: 'idle' }, false, null)).toBeNull()
    expect(updateStatusText({ status: 'none' }, false, null)).toBeNull()
    expect(updateStatusText({ status: 'error', message: 'x' }, false, null)).toBeNull()
    expect(
      updateStatusText({ status: 'downloading', version: '1.1.0', percent: 10 }, false, null)
    ).toBe('Downloading v1.1.0 (10%)…')
    expect(updateStatusText({ status: 'downloaded', version: '1.1.0' }, false, null)).toBe(
      'v1.1.0 is ready. Restart to update.'
    )
  })

  test('checking while the check runs', () => {
    expect(updateStatusText({ status: 'none' }, true, null)).toBe('Checking…')
    expect(updateStatusText({ status: 'checking' }, true, { ok: true })).toBe('Checking…')
  })

  test('up to date', () => {
    expect(updateStatusText({ status: 'none' }, true, { ok: true })).toBe(
      "You're on the latest version."
    )
  })

  test("the check's error, or the updater's", () => {
    expect(
      updateStatusText({ status: 'idle' }, true, {
        ok: false,
        error: 'Updates only run in the installed app.'
      })
    ).toBe('Updates only run in the installed app.')
    expect(updateStatusText({ status: 'error', message: 'offline' }, true, { ok: true })).toBe(
      'offline'
    )
  })

  test('a download without a known version yet', () => {
    expect(
      updateStatusText({ status: 'downloading', version: '', percent: null }, true, null)
    ).toBe('Downloading the update…')
  })
})
