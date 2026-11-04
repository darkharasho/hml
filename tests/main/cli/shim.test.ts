import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  installShim,
  shimContents,
  shimFile,
  shimStatus,
  type ShimTarget
} from '../../../src/main/cli/shim'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('shim', () => {
  it('writes a Windows .cmd into WindowsApps that passes arguments through', () => {
    const t: ShimTarget = {
      platform: 'win32',
      home: 'C:\\Users\\me',
      localAppData: 'C:\\Users\\me\\AppData\\Local',
      command: ['C:\\Program Files\\HML\\hml.exe'],
      pathEnv: ''
    }
    expect(shimFile(t)).toBe('C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\hml.cmd')
    expect(shimContents(t)).toContain('"C:\\Program Files\\HML\\hml.exe" --cli %*')
  })

  it.skipIf(process.platform === 'win32')(
    'installs an executable script and reports PATH and staleness',
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), 'hml-shim-'))
      dirs.push(home)
      const bin = path.join(home, '.local', 'bin')
      const t: ShimTarget = {
        platform: 'linux',
        home,
        command: ["/opt/it's/HML.AppImage"],
        pathEnv: `/usr/bin:${bin}/`
      }
      expect(await shimStatus(t)).toMatchObject({ installed: false, stale: false, onPath: true })
      const s = await installShim(t)
      expect(s).toMatchObject({ installed: true, stale: false })
      expect((await stat(s.file)).mode & 0o111).not.toBe(0)
      expect(await readFile(s.file, 'utf8')).toContain(
        `exec '/opt/it'\\''s/HML.AppImage' --cli "$@"`
      )
      await mkdir(bin, { recursive: true })
      await writeFile(s.file, '#!/bin/sh\nexec /elsewhere --cli "$@"\n')
      expect(await shimStatus(t)).toMatchObject({ installed: false, stale: true })
    }
  )
})
