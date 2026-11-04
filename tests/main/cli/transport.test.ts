import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cliEndpoint, sendCliRequest, startCliServer } from '../../../src/main/cli/transport'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'hml-cli-'))
  dirs.push(d)
  return d
}

describe.skipIf(process.platform === 'win32')('cli transport', () => {
  it('forwards argv and cwd to the running app and returns its result', async () => {
    const ep = cliEndpoint(await tmp(), process.platform)
    const stop = await startCliServer(ep, async (argv, cwd) => ({
      code: 3,
      stdout: `${argv.join(' ')} @ ${cwd}`,
      stderr: ''
    }))
    try {
      expect((await stat(ep.tokenFile)).mode & 0o777).toBe(0o600)
      expect(await sendCliRequest(ep, ['mods', 'repo'], '/work')).toEqual({
        code: 3,
        stdout: 'mods repo @ /work',
        stderr: ''
      })
    } finally {
      await stop()
    }
  })

  it('is null when no HML is listening, even with a stale token', async () => {
    const ep = cliEndpoint(await tmp(), process.platform)
    expect(await sendCliRequest(ep, ['help'], '/')).toBeNull()
    await writeFile(ep.tokenFile, 'stale')
    expect(await sendCliRequest(ep, ['help'], '/')).toBeNull()
  })

  it('refuses a request with the wrong token', async () => {
    const ep = cliEndpoint(await tmp(), process.platform)
    const stop = await startCliServer(ep, async () => ({ code: 0, stdout: 'ran', stderr: '' }))
    try {
      const wrong = { ...ep, tokenFile: path.join(path.dirname(ep.tokenFile), 'other') }
      await writeFile(wrong.tokenFile, 'not-the-token')
      const r = await sendCliRequest(wrong, ['help'], '/')
      expect(r?.stdout).toBe('')
      expect(r?.stderr).toContain('refused')
    } finally {
      await stop()
    }
  })
})
