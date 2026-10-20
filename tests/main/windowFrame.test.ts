import { describe, expect, test } from 'vitest'
import {
  isMainFrameRequest,
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
  function fakeWindow(): ControllableWindow & {
    calls: string[]
    maximized: boolean
    fullScreen: boolean
  } {
    const w = {
      calls: [] as string[],
      maximized: false,
      fullScreen: false,
      isFullScreen: () => w.fullScreen,
      setFullScreen: (on: boolean) => {
        w.calls.push(`fullscreen:${on}`)
        w.fullScreen = on
      },
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
      close: () => void w.calls.push('close'),
      webContents: {
        cut: () => void w.calls.push('cut'),
        copy: () => void w.calls.push('copy'),
        paste: () => void w.calls.push('paste'),
        selectAll: () => void w.calls.push('selectAll')
      }
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

  test("edit commands go to the window's page", () => {
    const w = fakeWindow()
    const c = windowControls(w)
    c.cut()
    c.copy()
    c.paste()
    c.selectAll()
    expect(w.calls).toEqual(['cut', 'copy', 'paste', 'selectAll'])
  })

  test('in full screen it counts as maximized, and the toggle leaves full screen', () => {
    const w = fakeWindow()
    w.fullScreen = true
    const c = windowControls(w)
    expect(c.isMaximized()).toBe(true)
    c.toggleMaximize()
    expect(w.calls).toEqual(['fullscreen:false'])
    expect(c.isMaximized()).toBe(false)
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
  expect(WINDOW_METHODS).toEqual([
    'minimize',
    'toggleMaximize',
    'close',
    'isMaximized',
    'cut',
    'copy',
    'paste',
    'selectAll'
  ])
  expect(windowChannel('close')).toBe('hml:window:close')
})

describe('isMainFrameRequest', () => {
  const mainFrame = {}
  test('true only for the main frame of the sending page', () => {
    expect(isMainFrameRequest({ senderFrame: mainFrame, sender: { mainFrame } })).toBe(true)
    expect(isMainFrameRequest({ senderFrame: {}, sender: { mainFrame } })).toBe(false)
    expect(isMainFrameRequest({ senderFrame: null, sender: { mainFrame } })).toBe(false)
  })
})
