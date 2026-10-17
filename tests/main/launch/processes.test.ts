import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  isGameProcessRunning,
  isGameRunning,
  isSteamProcess,
  linuxProcessNames,
  matchesGameExe,
  parseTasklist,
  PROC_SCAN_CONCURRENCY,
  steamShutdownCommand,
  waitForGameStart,
  waitForSteamExit,
  type ProcFsPort
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

/** A fake /proc from pid → [comm, cmdline argv, state]; records every file read. */
function fakeProc(procs: Record<string, [string, string[], string?]>): ProcFsPort & {
  reads: string[]
} {
  const reads: string[] = []
  return {
    reads,
    async readdir() {
      return [...Object.keys(procs), 'self', 'sys']
    },
    async readFile(file) {
      reads.push(file)
      const [, , pid, kind] = file.split('/')
      const p = procs[pid]
      if (!p) throw new Error('ENOENT')
      if (kind === 'stat') return `${pid} (${p[0]}) ${p[2] ?? 'S'} 1 ${pid} ${pid} 0 -1\n`
      if (kind === 'cmdline') return p[1].join('\0') + '\0'
      throw new Error(`unexpected read ${file}`)
    }
  }
}
const noExec = async (): Promise<{ stdout: string }> => {
  throw new Error('not used')
}

describe('isGameProcessRunning on linux', () => {
  test('finds a Proton game by its comm without reading its cmdline', async () => {
    const proc = fakeProc({ '42': ['REPO.exe', ['Z:\\home\\me\\REPO\\REPO.exe']] })
    expect(await isGameProcessRunning('linux', noExec, ['REPO.exe'], proc)).toBe(true)
    expect(proc.reads).toEqual(['/proc/42/stat'])
  })

  test("reads argv[0] when the comm doesn't match", async () => {
    // Wine can leave a comm like "wine64-preload"; argv[0] still names the exe.
    const proc = fakeProc({ '42': ['wine64-preload', ['C:\\Games\\REPO.exe', '-batch']] })
    expect(await isGameProcessRunning('linux', noExec, ['REPO.exe'], proc)).toBe(true)
    expect(proc.reads).toEqual(['/proc/42/stat', '/proc/42/cmdline'])
  })

  test('false when no process is the game', async () => {
    const proc = fakeProc({
      '1': ['systemd', ['/usr/lib/systemd/systemd']],
      '9': ['proton', ['/usr/bin/python3', 'proton', 'run', 'REPO.exe']]
    })
    expect(await isGameProcessRunning('linux', noExec, ['REPO.exe'], proc)).toBe(false)
  })

  test('skips zombie processes', async () => {
    const proc = fakeProc({ '42': ['REPO.exe', ['C:\\Games\\REPO.exe'], 'Z'] })
    expect(await isGameProcessRunning('linux', noExec, ['REPO.exe'], proc)).toBe(false)
    expect(proc.reads).toEqual(['/proc/42/stat'])
  })

  test('a comm with spaces and parentheses is read from stat correctly', async () => {
    const proc = fakeProc({ '42': ['Game (x64).exe', ['/x']] })
    expect(await isGameProcessRunning('linux', noExec, ['Game (x64).exe'], proc)).toBe(true)
  })

  test('skips processes that exit while being read', async () => {
    const proc = fakeProc({ '7': ['bash', ['/bin/bash']] })
    const r = await isGameProcessRunning('linux', noExec, ['REPO.exe'], {
      readdir: async () => ['7', '8'],
      readFile: proc.readFile
    })
    expect(r).toBe(false)
  })

  test('reads at most a few processes at a time and stops once found', async () => {
    let active = 0
    let peak = 0
    const procs: Record<string, [string, string[]]> = {}
    for (let i = 1; i <= 200; i++) procs[String(i)] = ['bash', ['/bin/bash']]
    procs['50'] = ['REPO.exe', ['C:\\REPO.exe']]
    const inner = fakeProc(procs)
    const proc: ProcFsPort = {
      readdir: inner.readdir,
      async readFile(file) {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 0))
        active--
        return inner.readFile(file)
      }
    }
    expect(await isGameProcessRunning('linux', noExec, ['REPO.exe'], proc)).toBe(true)
    expect(peak).toBeLessThanOrEqual(PROC_SCAN_CONCURRENCY)
    expect(inner.reads.filter((f) => f.endsWith('/stat')).length).toBeLessThan(200)
  })
})

describe('isGameProcessRunning', () => {
  test('on win32, uses tasklist', async () => {
    const exec = async (): Promise<{ stdout: string }> => ({ stdout: TASKLIST })
    expect(await isGameProcessRunning('win32', exec, ['REPO.exe'])).toBe(true)
    expect(await isGameProcessRunning('win32', exec, ['Other.exe'])).toBe(false)
  })

  test('null without exe names or on a platform HML cannot list', async () => {
    const proc = fakeProc({ '42': ['REPO.exe', ['C:\\Games\\REPO.exe']] })
    expect(await isGameProcessRunning('linux', noExec, [], proc)).toBeNull()
    expect(await isGameProcessRunning('darwin', noExec, ['REPO.exe'], proc)).toBeNull()
  })
})

describe('matchesGameExe', () => {
  test('matches by basename, ignoring case', () => {
    expect(matchesGameExe('repo.exe', ['Game/REPO.exe'])).toBe(true)
    expect(matchesGameExe('other.exe', ['REPO.exe'])).toBe(false)
  })

  test("matches Linux's 15-character comm of a longer exe name", () => {
    expect(matchesGameExe('lethal company.', ['Lethal Company.exe'])).toBe(true)
    // A short name is never a prefix match.
    expect(matchesGameExe('lethal', ['Lethal Company.exe'])).toBe(false)
  })

  test('an exe name of exactly 15 characters matches only itself', () => {
    expect('ValheimGame.exe').toHaveLength(15)
    expect(matchesGameExe('valheimgame.exe', ['ValheimGame.exe'])).toBe(true)
    expect(matchesGameExe('valheimgame.ex', ['ValheimGame.exe'])).toBe(false)
    expect(matchesGameExe('valheimgame.exx', ['ValheimGame.exe'])).toBe(false)
  })

  test('a 16-character exe name matches its cut comm', () => {
    expect('ValheimGame2.exe').toHaveLength(16)
    expect(matchesGameExe('valheimgame2.ex', ['ValheimGame2.exe'])).toBe(true)
  })
})

describe('waitForGameStart', () => {
  /** A fake clock that advances only when the watcher sleeps. */
  function clock(): { now(): number; sleep(ms: number): Promise<void>; sleeps: number[] } {
    let t = 0
    const sleeps: number[] = []
    return {
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms)
        t += ms
      },
      sleeps
    }
  }

  test('resolves running once the check sees the game', async () => {
    const c = clock()
    const answers = [false, false, true]
    const result = await waitForGameStart({ check: async () => answers.shift()!, ...c })
    expect(result).toBe('running')
    expect(c.sleeps).toEqual([1000, 1000])
  })

  test('resolves running at once when the game already runs', async () => {
    const c = clock()
    expect(await waitForGameStart({ check: async () => true, ...c })).toBe('running')
    expect(c.sleeps).toEqual([])
  })

  test('gives up with timeout after two minutes by default', async () => {
    const c = clock()
    let checks = 0
    const result = await waitForGameStart({
      check: async () => {
        checks++
        return false
      },
      ...c
    })
    expect(result).toBe('timeout')
    expect(c.now()).toBe(120_000)
    expect(checks).toBe(121)
  })

  test('the last sleep is cut to the deadline', async () => {
    const c = clock()
    await waitForGameStart({
      check: async () => false,
      intervalMs: 400,
      timeoutMs: 1000,
      ...c
    })
    expect(c.sleeps).toEqual([400, 400, 200])
  })

  test('unknown when the game cannot be detected', async () => {
    const c = clock()
    expect(await waitForGameStart({ check: async () => null, ...c })).toBe('unknown')
  })

  test('a failing check counts as not running yet', async () => {
    const c = clock()
    const answers: (() => Promise<boolean>)[] = [
      () => Promise.reject(new Error('tasklist failed')),
      async () => true
    ]
    expect(await waitForGameStart({ check: () => answers.shift()!(), ...c })).toBe('running')
  })

  test('cancelled when the signal aborts, even mid-sleep, and checks no more', async () => {
    const ac = new AbortController()
    let checks = 0
    const result = waitForGameStart({
      check: async () => {
        checks++
        return false
      },
      signal: ac.signal
      // The real sleep: abort has to cut it short.
    })
    await new Promise((r) => setTimeout(r, 10))
    ac.abort()
    expect(await result).toBe('cancelled')
    expect(checks).toBe(1)
  })

  test('cancelled at once for an already aborted signal', async () => {
    const ac = new AbortController()
    ac.abort()
    let checks = 0
    const check = async (): Promise<boolean> => {
      checks++
      return true
    }
    expect(await waitForGameStart({ check, signal: ac.signal })).toBe('cancelled')
    expect(checks).toBe(0)
  })

  test('exited when the launched program exits before the game is seen', async () => {
    let exit!: () => void
    const exited = new Promise<void>((r) => (exit = r))
    const result = waitForGameStart({ check: async () => false, exited })
    await new Promise((r) => setTimeout(r, 10))
    exit()
    expect(await result).toBe('exited')
  })

  test('running when the launcher exits but the game is up by then', async () => {
    let up = false
    let exit!: () => void
    const exited = new Promise<void>((r) => (exit = r))
    const result = waitForGameStart({ check: async () => up, exited })
    await new Promise((r) => setTimeout(r, 10))
    up = true
    exit()
    expect(await result).toBe('running')
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

  test('isSteamProcess matches steam, steam.sh and steamwebhelper only', () => {
    for (const n of ['steam', 'steam.sh', 'steamwebhelper']) {
      expect(isSteamProcess(n)).toBe(true)
    }
    // REAPER (the DAW) shares a name with Steam's game reaper, which never runs without Steam.
    for (const n of ['reaper', 'steamos-session', 'hml', 'Steam.exe', 'bash']) {
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
