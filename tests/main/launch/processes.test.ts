import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  isGameRunning,
  isSteamProcess,
  linuxProcessNames,
  parseTasklist,
  steamShutdownCommand,
  waitForSteamExit
} from '../../../src/main/launch/processes'

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

describe('Steam processes', () => {
  let proc: string
  beforeEach(async () => {
    proc = await fs.mkdtemp(path.join(os.tmpdir(), 'hml-proc-'))
  })
  afterEach(async () => {
    await fs.rm(proc, { recursive: true, force: true })
  })
  async function addProc(pid: string, comm: string | null): Promise<void> {
    await fs.mkdir(path.join(proc, pid), { recursive: true })
    if (comm !== null) await fs.writeFile(path.join(proc, pid, 'comm'), comm + '\n')
  }

  test('linuxProcessNames reads each numeric pid comm, skipping unreadable ones', async () => {
    await addProc('1', 'systemd')
    await addProc('42', 'steamwebhelper')
    await addProc('43', null)
    await addProc('self', 'nope')
    expect((await linuxProcessNames(proc)).sort()).toEqual(['steamwebhelper', 'systemd'])
  })

  test('isSteamProcess matches steam, steam.sh, steamwebhelper and reaper only', () => {
    for (const n of ['steam', 'steam.sh', 'steamwebhelper', 'reaper']) {
      expect(isSteamProcess(n)).toBe(true)
    }
    for (const n of ['steamos-session', 'hml', 'Steam.exe', 'bash']) {
      expect(isSteamProcess(n)).toBe(false)
    }
  })

  test('steamShutdownCommand uses flatpak run for Flatpak Steam', () => {
    expect(steamShutdownCommand(false)).toEqual({ command: 'steam', args: ['-shutdown'] })
    expect(steamShutdownCommand(true)).toEqual({
      command: 'flatpak',
      args: ['run', 'com.valvesoftware.Steam', '-shutdown']
    })
  })

  test('waitForSteamExit polls until Steam is gone', async () => {
    let t = 0
    const answers = [true, true, false]
    const sleeps: number[] = []
    const gone = await waitForSteamExit(async () => answers.shift()!, {
      timeoutMs: 30_000,
      intervalMs: 500,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms)
        t += ms
      }
    })
    expect(gone).toBe(true)
    expect(sleeps).toEqual([500, 500])
  })

  test('waitForSteamExit gives up after the timeout', async () => {
    let t = 0
    let checks = 0
    const gone = await waitForSteamExit(
      async () => {
        checks++
        return true
      },
      {
        timeoutMs: 30_000,
        intervalMs: 1000,
        now: () => t,
        sleep: async (ms) => {
          t += ms
        }
      }
    )
    expect(gone).toBe(false)
    expect(checks).toBe(31)
  })
})
