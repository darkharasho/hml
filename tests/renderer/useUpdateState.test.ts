import { describe, expect, test } from 'vitest'
import type { UpdateState } from '../../src/shared/ipc'
import { followUpdateState } from '../../src/renderer/src/useUpdateState'

function bridge(): {
  onState(cb: (s: UpdateState) => void): () => void
  getState(): Promise<UpdateState>
  push(s: UpdateState): void
  answer(s: UpdateState): Promise<void>
  fail(): Promise<void>
  listeners: number
} {
  let cbs: ((s: UpdateState) => void)[] = []
  let resolve: (s: UpdateState) => void = () => undefined
  let reject: (e: unknown) => void = () => undefined
  const pending = new Promise<UpdateState>((res, rej) => {
    resolve = res
    reject = rej
  })
  const b = {
    get listeners() {
      return cbs.length
    },
    onState(cb: (s: UpdateState) => void) {
      cbs.push(cb)
      return () => {
        cbs = cbs.filter((c) => c !== cb)
      }
    },
    getState: () => pending,
    push: (s: UpdateState) => cbs.forEach((c) => c(s)),
    async answer(s: UpdateState) {
      resolve(s)
      await pending
      await Promise.resolve()
    },
    async fail() {
      reject(new Error('gone'))
      await pending.catch(() => undefined)
      await Promise.resolve()
    }
  }
  return b
}

describe('followUpdateState', () => {
  test('takes the current state when nothing was pushed', async () => {
    const b = bridge()
    const seen: UpdateState[] = []
    followUpdateState(b, (s) => seen.push(s))
    await b.answer({ status: 'downloaded', version: '1.1.0' })
    expect(seen).toEqual([{ status: 'downloaded', version: '1.1.0' }])
  })

  test('a pushed state beats a late answer', async () => {
    const b = bridge()
    const seen: UpdateState[] = []
    followUpdateState(b, (s) => seen.push(s))
    b.push({ status: 'downloading', version: '1.1.0', percent: 5 })
    await b.answer({ status: 'checking' })
    expect(seen).toEqual([{ status: 'downloading', version: '1.1.0', percent: 5 }])
  })

  test('nothing after unsubscribing, and a failed ask is ignored', async () => {
    const b = bridge()
    const seen: UpdateState[] = []
    const off = followUpdateState(b, (s) => seen.push(s))
    expect(b.listeners).toBe(1)
    off()
    expect(b.listeners).toBe(0)
    b.push({ status: 'none' })
    await b.answer({ status: 'none' })
    expect(seen).toEqual([])

    const b2 = bridge()
    followUpdateState(b2, (s) => seen.push(s))
    await b2.fail()
    expect(seen).toEqual([])
  })
})
