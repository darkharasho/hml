import { describe, expect, test } from 'vitest'
import {
  titlebarOptions,
  windowControls,
  type ControllableWindow
} from '../../src/main/windowFrame'
import { WINDOW_METHODS, windowChannel } from '../../src/shared/ipc'

describe('titlebarOptions', () => {
  test('macOS hides the title bar but keeps the traffic lights, centered in the bar', () => {
    const o = titlebarOptions('darwin')
    expect(o.titleBarStyle).toBe('hidden')
    expect(o.frame).toBeUndefined()
    expect(o.trafficLightPosition).toEqual({ x: 14, y: 12 })
  })

  test.each(['win32', 'linux'] as const)(
    '%s hides the title bar, without frame: false so double-click still maximizes',
    (platform) => {
      expect(titlebarOptions(platform)).toEqual({ titleBarStyle: 'hidden' })
    }
  )
})

describe('windowControls', () => {
  function fakeWindow(): ControllableWindow & { calls: string[]; maximized: boolean } {
    const w = {
      calls: [] as string[],
      maximized: false,
      minimize: () => void w.calls.push('minimize'),
      maximize: () => {
        w.calls.push('maximize')
        w.maximized = true
      },
      unmaximize: () => {
        w.calls.push('unmaximize')
        w.maximized = false
      },
      isMaximized: () => w.maximized,
      close: () => void w.calls.push('close')
    }
    return w
  }

  test('toggleMaximize maximizes, then restores', () => {
    const w = fakeWindow()
    const c = windowControls(w)
    c.toggleMaximize()
    expect(c.isMaximized()).toBe(true)
    c.toggleMaximize()
    expect(c.isMaximized()).toBe(false)
    expect(w.calls).toEqual(['maximize', 'unmaximize'])
  })

  test('minimize and close go to the window', () => {
    const w = fakeWindow()
    const c = windowControls(w)
    c.minimize()
    c.close()
    expect(w.calls).toEqual(['minimize', 'close'])
  })
})

test('window channels are namespaced apart from the HML API', () => {
  expect(WINDOW_METHODS).toEqual(['minimize', 'toggleMaximize', 'close', 'isMaximized'])
  expect(windowChannel('close')).toBe('hml:window:close')
})
