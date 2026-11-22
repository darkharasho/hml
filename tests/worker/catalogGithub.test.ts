import { describe, expect, it, vi } from 'vitest'
import {
  GhGraphqlError,
  RELEASES_PAGE_SIZE,
  RELEASES_QUERY,
  SEARCH_QUERY,
  fetchMoreReleases,
  fetchSearchPage
} from '../../worker/src/catalog/github'
import page from '../fixtures/gh-graphql-page.json'

const ok = (body: unknown, status = 200): typeof fetch =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('fetchSearchPage', () => {
  it('POSTs the query with auth headers and cursor variable', async () => {
    const f = ok(page)
    await fetchSearchPage(f, 'tok', 'CUR')
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit
    ]
    expect(url).toBe('https://api.github.com/graphql')
    expect(init.method).toBe('POST')
    const h = init.headers as Record<string, string>
    expect(h.authorization).toBe('bearer tok')
    expect(h['user-agent']).toBe('hml-catalog')
    expect(h['content-type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({
      query: SEARCH_QUERY,
      variables: { cursor: 'CUR', first: 30 }
    })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('sorts the search by creation date so pagination is stable', () => {
    expect(SEARCH_QUERY).toContain(
      'query: "topic:hml-mod archived:false fork:true sort:created-asc"'
    )
  })

  it('sends first=30 by default and honors an explicit page size', async () => {
    const vars = (f: typeof fetch): unknown =>
      JSON.parse(
        ((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit).body as string
      ).variables
    const f1 = ok(page)
    await fetchSearchPage(f1, 't', null)
    expect(vars(f1)).toMatchObject({ first: 30 })
    const f2 = ok(page)
    await fetchSearchPage(f2, 't', null, 15)
    expect(vars(f2)).toMatchObject({ first: 15 })
  })

  it('maps repos, skipping malformed nodes', async () => {
    const r = await fetchSearchPage(ok(page), 't', null)
    expect(r.total).toBe(3)
    expect(r.nextCursor).toBe('Y3Vyc29yOjEwMA==')
    expect(r.repos.map((x) => x.repo)).toEqual(['cool-mod', 'no-manifest', 'huge-manifest'])
    const a = r.repos[0]
    expect(a).toMatchObject({
      id: '1001',
      ownerId: 'MDQ6VXNlcjE=',
      owner: 'alice',
      repo: 'cool-mod',
      stars: 42,
      createdAt: '2026-01-02T03:04:05Z',
      ownerAvatar: 'https://avatars.githubusercontent.com/u/1?v=4',
      defaultBranch: 'main',
      archived: false
    })
    expect(a.manifest).toContain('"schema":1')
    expect(a.manifestTooLarge).toBeUndefined()
    expect(a.releases[0]).toEqual({
      tag: 'v1.2.0',
      draft: false,
      prerelease: false,
      publishedAt: '2026-03-01T00:00:00Z',
      assets: [{ name: 'cool.zip', size: 2048, downloads: 17 }]
    })
    expect(a.releases[1].draft).toBe(true)
  })

  it('maps missing manifest and archived', async () => {
    const r = await fetchSearchPage(ok(page), 't', null)
    expect(r.repos[1].manifest).toBeNull()
    expect(r.repos[1].archived).toBe(true)
    expect(r.repos[1].manifestTooLarge).toBeUndefined()
  })

  it('flags oversized manifests', async () => {
    const r = await fetchSearchPage(ok(page), 't', null)
    expect(r.repos[2].manifest).toBeNull()
    expect(r.repos[2].manifestTooLarge).toBe(true)
  })

  it('treats a binary blob (null text) as no manifest', async () => {
    const p = structuredClone(page)
    ;(p.data.search.nodes[0] as { object: unknown }).object = { text: null, byteSize: 10 }
    const r = await fetchSearchPage(ok(p), 't', null)
    expect(r.repos[0].manifest).toBeNull()
    expect(r.repos[0].manifestTooLarge).toBeUndefined()
  })

  it('returns null cursor on the last page', async () => {
    const p = structuredClone(page)
    p.data.search.pageInfo = { hasNextPage: false, endCursor: 'x' }
    expect((await fetchSearchPage(ok(p), 't', null)).nextCursor).toBeNull()
  })

  it('throws GhGraphqlError with the HTTP status', async () => {
    const e = await fetchSearchPage(ok({}, 502), 't', null).catch((x) => x)
    expect(e).toBeInstanceOf(GhGraphqlError)
    expect(e.status).toBe(502)
  })

  it('throws on errors without data', async () => {
    const e = await fetchSearchPage(
      ok({ errors: [{ message: 'Bad credentials' }] }),
      't',
      null
    ).catch((x) => x)
    expect(e).toBeInstanceOf(GhGraphqlError)
    expect(e.status).toBe(200)
    expect(e.message).toContain('Bad credentials')
  })
})

describe('release follow-ups', () => {
  const relNode = (tag: string): unknown => ({
    tagName: tag,
    isDraft: false,
    isPrerelease: false,
    publishedAt: '2026-01-01T00:00:00Z',
    releaseAssets: { nodes: [{ name: 'a.zip', size: 1, downloadCount: 2 }] }
  })

  it('keeps the releases cursor of a repo with more releases than the search returned', async () => {
    const body = structuredClone(page) as {
      data: { search: { nodes: { releases?: Record<string, unknown> }[] } }
    }
    body.data.search.nodes[0].releases!.pageInfo = { hasNextPage: true, endCursor: 'R1' }
    const r = await fetchSearchPage(ok(body), 't', null)
    expect(r.repos[0].releasesCursor).toBe('R1')
    expect(r.repos[1].releasesCursor).toBeUndefined()
    expect(SEARCH_QUERY).toMatch(
      /releases\(first: 20[^)]*\) \{\s*pageInfo \{ hasNextPage endCursor \}/
    )
  })

  it('fetches the next page of one repo’s releases', async () => {
    const f = ok({
      data: {
        repository: {
          releases: {
            pageInfo: { hasNextPage: true, endCursor: 'R2' },
            nodes: [relNode('b-v1.0.0'), { bad: true }]
          }
        }
      }
    })
    const r = await fetchMoreReleases(f, 'tok', 'alice', 'mono', 'R1')
    const init = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
    expect(JSON.parse(init.body as string)).toEqual({
      query: RELEASES_QUERY,
      variables: { owner: 'alice', name: 'mono', after: 'R1', first: RELEASES_PAGE_SIZE }
    })
    expect(r.releases.map((x) => x.tag)).toEqual(['b-v1.0.0'])
    expect(r.nextCursor).toBe('R2')
  })

  it('throws on a follow-up without a repository', async () => {
    await expect(
      fetchMoreReleases(ok({ data: { repository: null } }), 't', 'a', 'b', 'R1')
    ).rejects.toThrow(GhGraphqlError)
  })
})
