import { describe, expect, it, vi } from 'vitest'
import { downloadShare, uploadShare } from '../../src/main/share/client'
import { MAX_HML_BYTES } from '../../src/main/share/hmlFile'
import { formatCode, normalizeCode } from '../../src/shared/shareCode'

const base = 'https://share.test'
const UNAVAILABLE = 'Share codes are unavailable right now. Export a file instead.'

const reply = (body: BodyInit | null, status = 200): typeof fetch =>
  vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch

describe('formatCode', () => {
  it('splits into two groups of five', () => {
    expect(formatCode('ABCDEFGHJK')).toBe('ABCDE-FGHJK')
    expect(normalizeCode('abcde-fghjk')).toBe('ABCDEFGHJK')
  })
})

describe('uploadShare', () => {
  it('sends only the zip bytes with minimal headers and returns the normalized code', async () => {
    const f = vi.fn(async () => Response.json({ code: 'abcde-fghjk' })) as unknown as typeof fetch
    const data = new Uint8Array([1, 2, 3])
    expect(await uploadShare({ fetch: f, base }, data)).toBe('ABCDEFGHJK')
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit
    ]
    expect(url).toBe(`${base}/v1/profiles`)
    expect(init.method).toBe('POST')
    expect(init.body).toBe(data)
    expect(init.headers).toEqual({ 'content-type': 'application/zip', 'user-agent': 'HML' })
  })

  it.each([
    [400, "This profile file couldn't be shared."],
    [404, UNAVAILABLE],
    [413, 'This profile is too large to share (over 10 MB).'],
    [429, 'Too many share codes created. Try again in a minute.'],
    [500, UNAVAILABLE],
    [503, UNAVAILABLE]
  ])('maps status %i', async (status, msg) => {
    await expect(
      uploadShare({ fetch: reply('x', status), base }, new Uint8Array())
    ).rejects.toThrow(msg)
  })

  it('maps network errors and bad bodies to unavailable', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(uploadShare({ fetch: down, base }, new Uint8Array())).rejects.toThrow(UNAVAILABLE)
    await expect(
      uploadShare({ fetch: reply('{"code":"nope"}'), base }, new Uint8Array())
    ).rejects.toThrow(UNAVAILABLE)
  })

  it('aborts a request that exceeds the timeout', async () => {
    const hang = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init.signal!.addEventListener('abort', () =>
            rej(new DOMException('aborted', 'AbortError'))
          )
        })
    ) as unknown as typeof fetch
    await expect(
      uploadShare({ fetch: hang, base, timeoutMs: 20 }, new Uint8Array())
    ).rejects.toThrow(UNAVAILABLE)
  })

  it.each([
    [0, 30_000],
    [5_000_000, 130_000],
    [100_000_000, 300_000]
  ])('scales the upload timeout with size (%i bytes -> %i ms)', async (size, ms) => {
    vi.useFakeTimers()
    try {
      const hang = vi.fn(
        (_u: string, init: RequestInit) =>
          new Promise<Response>((_res, rej) => {
            init.signal!.addEventListener('abort', () => rej(new Error('aborted')))
          })
      ) as unknown as typeof fetch
      const p = expect(uploadShare({ fetch: hang, base }, new Uint8Array(size))).rejects.toThrow(
        UNAVAILABLE
      )
      const sig = (): AbortSignal =>
        (hang as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].signal
      await vi.advanceTimersByTimeAsync(ms - 1)
      expect(sig().aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(sig().aborted).toBe(true)
      await p
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses a 30 s default timeout', async () => {
    vi.useFakeTimers()
    try {
      const hang = vi.fn(
        (_u: string, init: RequestInit) =>
          new Promise<Response>((_res, rej) => {
            init.signal!.addEventListener('abort', () => rej(new Error('aborted')))
          })
      ) as unknown as typeof fetch
      const p = expect(downloadShare({ fetch: hang, base }, 'ABCDEFGHJK')).rejects.toThrow(
        UNAVAILABLE
      )
      await vi.advanceTimersByTimeAsync(29_999)
      expect((hang as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].signal.aborted).toBe(
        false
      )
      await vi.advanceTimersByTimeAsync(1)
      await p
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('unread bodies', () => {
  const withBody = (
    status: number,
    headers: Record<string, string> = {}
  ): {
    f: typeof fetch
    cancelled: () => boolean
  } => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array([1]))
      },
      cancel() {
        cancelled = true
      }
    })
    const f = vi.fn(async () => new Response(body, { status, headers })) as unknown as typeof fetch
    return { f, cancelled: () => cancelled }
  }

  it('cancels the body of an error response', async () => {
    const { f, cancelled } = withBody(502)
    await expect(downloadShare({ fetch: f, base }, 'ABCDEFGHJK')).rejects.toThrow(UNAVAILABLE)
    await new Promise((r) => setTimeout(r, 0))
    expect(cancelled()).toBe(true)
  })

  it('cancels the body when the declared length is too big', async () => {
    const { f, cancelled } = withBody(200, { 'content-length': String(MAX_HML_BYTES + 1) })
    await expect(downloadShare({ fetch: f, base }, 'ABCDEFGHJK')).rejects.toThrow(UNAVAILABLE)
    await new Promise((r) => setTimeout(r, 0))
    expect(cancelled()).toBe(true)
  })
})

describe('downloadShare', () => {
  it('rejects an invalid code without a request', async () => {
    const f = reply('x')
    await expect(downloadShare({ fetch: f, base }, 'nope')).rejects.toThrow(
      "That isn't a valid share code."
    )
    expect(f).not.toHaveBeenCalled()
  })

  it('normalizes the code and returns the bytes', async () => {
    const f = reply(new Uint8Array([9, 8, 7]))
    expect([...(await downloadShare({ fetch: f, base }, 'abcde-fghjk'))]).toEqual([9, 8, 7])
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      `${base}/v1/profiles/ABCDEFGHJK`
    )
  })

  it.each([
    [404, 'No profile has that share code. It may have expired.'],
    [413, UNAVAILABLE],
    [429, 'Too many downloads. Try again in a minute.'],
    [502, UNAVAILABLE]
  ])('maps status %i', async (status, msg) => {
    await expect(downloadShare({ fetch: reply('', status), base }, 'ABCDEFGHJK')).rejects.toThrow(
      msg
    )
  })

  it('strips trailing slashes from the base', async () => {
    const f = reply(new Uint8Array([1]))
    await downloadShare({ fetch: f, base: `${base}//` }, 'ABCDEFGHJK')
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      `${base}/v1/profiles/ABCDEFGHJK`
    )
    const u = vi.fn(async () => Response.json({ code: 'ABCDEFGHJK' })) as unknown as typeof fetch
    await uploadShare({ fetch: u, base: `${base}/` }, new Uint8Array())
    expect((u as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(`${base}/v1/profiles`)
  })

  it('caps the streamed body at MAX_HML_BYTES', async () => {
    const chunk = new Uint8Array(1024 * 1024)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        sent++
        c.enqueue(chunk)
      }
    })
    const f = vi.fn(async () => new Response(body)) as unknown as typeof fetch
    await expect(downloadShare({ fetch: f, base }, 'ABCDEFGHJK')).rejects.toThrow(UNAVAILABLE)
    expect(sent).toBeLessThan(MAX_HML_BYTES / chunk.length + 5)
  })
})
