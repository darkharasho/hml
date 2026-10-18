import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LOG_TAIL_BYTES, readLogFrom } from '../../../src/main/logs/logTail'

let tmp: string
let file: string
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hml-log-'))
  file = path.join(tmp, 'LogOutput.log')
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('readLogFrom', () => {
  test('a missing log reads as empty', async () => {
    expect(await readLogFrom(file, 0)).toEqual({ size: 0, next: 0, text: '', reset: true })
  })

  test('returns complete lines and follows on from where it stopped', async () => {
    await fs.writeFile(file, 'one\ntwo\npart')
    const a = await readLogFrom(file, 0)
    expect(a).toMatchObject({ text: 'one\ntwo\n', next: 8, reset: true })
    await fs.appendFile(file, 'ial\nthree\n')
    const b = await readLogFrom(file, a.next)
    expect(b).toMatchObject({ text: 'partial\nthree\n', reset: false })
    expect(await readLogFrom(file, b.next)).toMatchObject({ text: '', next: b.next })
  })

  test('starts over when the log got shorter', async () => {
    await fs.writeFile(file, 'old run\nmore\n')
    const a = await readLogFrom(file, 0)
    await fs.writeFile(file, 'new\n')
    expect(await readLogFrom(file, a.next)).toMatchObject({ text: 'new\n', reset: true })
  })

  test('a first read of a big log shows its end, from a line start', async () => {
    const line = 'x'.repeat(99) + '\n'
    await fs.writeFile(file, 'FIRST\n' + line.repeat(LOG_TAIL_BYTES / 100 + 10))
    const r = await readLogFrom(file, 0)
    expect(r.text.startsWith('x')).toBe(true)
    expect(r.text.includes('FIRST')).toBe(false)
    expect(r.text.length % 100).toBe(0)
    expect(r.next).toBe(r.size)
  })
})
