import { describe, expect, it, vi } from 'vitest'
import { createTsDocs, parseTsDoc, tsDocUrl } from '../../../src/main/thunderstore/docs'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('tsDocUrl', () => {
  it('builds the readme and changelog endpoints for a package version', () => {
    expect(tsDocUrl('BepInEx-BepInExPack', '5.4.2100', 'readme')).toBe(
      'https://thunderstore.io/api/experimental/package/BepInEx/BepInExPack/5.4.2100/readme/'
    )
    expect(tsDocUrl('Own-Mod', '1.0.0', 'changelog')).toBe(
      'https://thunderstore.io/api/experimental/package/Own/Mod/1.0.0/changelog/'
    )
  })

  it('refuses names and versions that could leave the package path', () => {
    expect(() => tsDocUrl('../x-y', '1.0.0', 'readme')).toThrow('Invalid Thunderstore package.')
    expect(() => tsDocUrl('Own-Mod', '1.0.0/../../x', 'readme')).toThrow()
    expect(() => tsDocUrl('OwnMod', '1.0.0', 'readme')).toThrow()
  })
})

describe('parseTsDoc', () => {
  it('returns the markdown, or null when missing or blank', () => {
    expect(parseTsDoc({ markdown: '# Hi' })).toBe('# Hi')
    expect(parseTsDoc({ markdown: null })).toBeNull()
    expect(parseTsDoc({ markdown: '  \n' })).toBeNull()
    expect(parseTsDoc(null)).toBeNull()
    expect(parseTsDoc({ markdown: 5 })).toBeNull()
  })
})

describe('createTsDocs', () => {
  it('fetches once per document and version', async () => {
    const fetch = vi.fn(async () => json({ markdown: '# Mod' }))
    const docs = createTsDocs({ fetch: fetch as unknown as typeof globalThis.fetch })
    expect(await docs.get('Own-Mod', '1.0.0', 'readme')).toBe('# Mod')
    expect(await docs.get('Own-Mod', '1.0.0', 'readme')).toBe('# Mod')
    expect(fetch).toHaveBeenCalledTimes(1)
    await docs.get('Own-Mod', '1.0.1', 'readme')
    await docs.get('Own-Mod', '1.0.0', 'changelog')
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('treats a 404 as no document', async () => {
    const fetch = vi.fn(async () => json({ detail: 'Not found.' }, 404))
    const docs = createTsDocs({ fetch: fetch as unknown as typeof globalThis.fetch })
    expect(await docs.get('Own-Mod', '1.0.0', 'changelog')).toBeNull()
  })

  it('does not remember a failure, so the next call retries', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ markdown: 'ok' }))
    const docs = createTsDocs({ fetch: fetch as unknown as typeof globalThis.fetch })
    await expect(docs.get('Own-Mod', '1.0.0', 'readme')).rejects.toThrow(
      'Thunderstore returned HTTP 503.'
    )
    expect(await docs.get('Own-Mod', '1.0.0', 'readme')).toBe('ok')
  })
})
