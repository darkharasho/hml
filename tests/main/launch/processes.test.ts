import { describe, expect, test } from 'vitest'
import { isGameRunning, parseTasklist } from '../../../src/main/launch/processes'

const TASKLIST = [
  '"System Idle Process","0","Services","0","8 K"',
  '"explorer.exe","4120","Console","1","120,332 K"',
  '"REPO.exe","9001","Console","1","1,204,112 K"',
  ''
].join('\r\n')

describe('parseTasklist', () => {
  test('returns the image names of tasklist /FO CSV /NH output', () => {
    expect(parseTasklist(TASKLIST)).toEqual(['System Idle Process', 'explorer.exe', 'REPO.exe'])
  })

  test('ignores lines that are not CSV rows', () => {
    expect(
      parseTasklist('INFO: No tasks are running which match the specified criteria.\r\n')
    ).toEqual([])
  })
})

describe('isGameRunning', () => {
  const calls: { file: string; args: string[] }[] = []
  const exec =
    (stdout: string) =>
    async (file: string, args: string[]): Promise<{ stdout: string }> => {
      calls.push({ file, args })
      return { stdout }
    }
  const failing = async (): Promise<{ stdout: string }> => {
    throw new Error('tasklist failed')
  }

  test('on win32, true when a game exe is in the list, matched by basename and case', async () => {
    calls.length = 0
    expect(await isGameRunning('win32', exec(TASKLIST), ['repo.EXE'])).toBe(true)
    expect(calls).toEqual([{ file: 'tasklist', args: ['/FO', 'CSV', '/NH'] }])
    expect(await isGameRunning('win32', exec(TASKLIST), ['Game\\Bin\\REPO.exe'])).toBe(true)
    expect(await isGameRunning('win32', exec(TASKLIST), ['bin/REPO.exe'])).toBe(true)
  })

  test('on win32, false when no game exe is in the list', async () => {
    expect(await isGameRunning('win32', exec(TASKLIST), ['Other.exe'])).toBe(false)
  })

  test('without exe names, false and tasklist is not run', async () => {
    calls.length = 0
    expect(await isGameRunning('win32', exec(TASKLIST), [])).toBe(false)
    expect(calls).toEqual([])
  })

  test('on win32, a failing tasklist gives the ifUnknown answer (true by default)', async () => {
    expect(await isGameRunning('win32', failing, ['REPO.exe'])).toBe(true)
    expect(await isGameRunning('win32', failing, ['REPO.exe'], false)).toBe(false)
  })

  test('on linux and macOS, false without running anything', async () => {
    calls.length = 0
    expect(await isGameRunning('linux', exec(TASKLIST), ['REPO.exe'])).toBe(false)
    expect(await isGameRunning('darwin', failing, ['REPO.exe'])).toBe(false)
    expect(calls).toEqual([])
  })
})
