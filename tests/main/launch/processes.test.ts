import { describe, expect, test } from 'vitest'
import {
  isGameProcessRunning,
  isGameRunning,
  matchesGameExe,
  parseTasklist,
  runningProgramNames,
  waitForGameStart,
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

/** A fake /proc from pid → [comm, cmdline argv]. */
function fakeProc(procs: Record<string, [string, string[]]>): ProcFsPort {
  return {
    async readdir() {
      return [...Object.keys(procs), 'self', 'sys']
    },
    async readFile(file) {
      const [, , pid, kind] = file.split('/')
      const p = procs[pid]
      if (!p) throw new Error('ENOENT')
      return kind === 'comm' ? `${p[0]}\n` : p[1].join('\0') + '\0'
    }
  }
}
const noExec = async (): Promise<{ stdout: string }> => {
  throw new Error('not used')
}

describe('runningProgramNames', () => {
  test('on linux, lists comm and argv[0] basenames, lower-cased', async () => {
    const names = await runningProgramNames(
      'linux',
      noExec,
      fakeProc({
        '1': ['systemd', ['/usr/lib/systemd/systemd']],
        '42': ['REPO.exe', ['Z:\\home\\me\\REPO\\REPO.exe', '-batch']]
      })
    )
    expect(names).toEqual(expect.arrayContaining(['systemd', 'repo.exe']))
    expect(names).not.toContain('-batch')
  })

  test('skips processes that exit while being read', async () => {
    const proc = fakeProc({ '7': ['bash', ['/bin/bash']] })
    const names = await runningProgramNames('linux', noExec, {
      readdir: async () => ['7', '8'],
      readFile: proc.readFile
    })
    expect(names).toEqual(['bash', 'bash'])
  })

  test('on win32, uses tasklist', async () => {
    const exec = async (): Promise<{ stdout: string }> => ({ stdout: TASKLIST })
    expect(await runningProgramNames('win32', exec)).toContain('repo.exe')
  })

  test('null on other platforms', async () => {
    expect(await runningProgramNames('darwin', noExec)).toBeNull()
  })
})

describe('matchesGameExe', () => {
  test('matches by basename, ignoring case', () => {
    expect(matchesGameExe(['repo.exe'], ['Game/REPO.exe'])).toBe(true)
    expect(matchesGameExe(['other.exe'], ['REPO.exe'])).toBe(false)
  })

  test("matches Linux's 15-character comm of a longer exe name", () => {
    expect(matchesGameExe(['lethal company.'], ['Lethal Company.exe'])).toBe(true)
    // A short name is never a prefix match.
    expect(matchesGameExe(['lethal'], ['Lethal Company.exe'])).toBe(false)
  })
})

describe('isGameProcessRunning', () => {
  const proc = fakeProc({ '42': ['REPO.exe', ['C:\\Games\\REPO.exe']] })

  test('true when the exe runs, false when not', async () => {
    expect(await isGameProcessRunning('linux', noExec, ['REPO.exe'], proc)).toBe(true)
    expect(await isGameProcessRunning('linux', noExec, ['Other.exe'], proc)).toBe(false)
  })

  test('null without exe names or on a platform HML cannot list', async () => {
    expect(await isGameProcessRunning('linux', noExec, [], proc)).toBeNull()
    expect(await isGameProcessRunning('darwin', noExec, ['REPO.exe'], proc)).toBeNull()
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
})
