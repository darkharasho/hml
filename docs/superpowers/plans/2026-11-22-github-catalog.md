# GitHub Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an open, Worker-indexed catalog of GitHub-hosted mods (topic `hml-mod` + required `hml.json`) as a third Online source in HML, with install through the existing GitHub path and a maintainer blocklist.

**Architecture:** A shared zod manifest validator (`src/shared/`) is used by the Worker, the app and the CLI. The `hml-share` Worker gets a resumable cron crawl. The crawl uses GitHub GraphQL to build per-game index JSON in KV (written only on change) and serves `/v1/catalog/*`. The app fetches and caches those indexes (ETag), shows a "GitHub" Online source, installs through the existing in-process `ghInstallWith`, and enforces the blocklist in the existing GitHub update paths.

**Tech Stack:** TypeScript, Electron, React + zustand + Tailwind, zod 4 (already a dependency, including `z.toJSONSchema`), Cloudflare Workers (KV, cron triggers), vitest.

**Spec:** `docs/superpowers/specs/2026-11-22-github-catalog-design.md`

## Global Constraints

- Worker stays on the **Cloudflare free plan**. Per invocation that means about 50 outbound requests and about 10 ms of CPU. Plan for **at most 3 GraphQL pages per cron run** (`CRAWL_PAGES_PER_RUN = 3`).
- KV writes happen **only when content changed** (compare SHA-256 of serialized value). The budget is 1,000 writes a day.
- Cron: `*/30 * * * *`.
- Discovery topic: `hml-mod`. Manifest path: `hml.json` at the default branch root (`HEAD:hml.json`). `schema` must be `1`.
- Manifest limits:
  - `mods`: 1–50 entries.
  - `id`: `^[a-z0-9-]{1,64}$`, unique within the repo.
  - `name`: ≤ 64 characters. `description`: ≤ 250.
  - `categories`: ≤ 5.
  - `tagPrefix` is required when `mods.length > 1`.
- Known game labels:
  - Thunderstore community slugs from `SCHEMA_URL` (`src/main/catalog/catalog.ts`). The Worker refetches it at most once a day.
  - Any label matching `^nexus-[a-z0-9-]+$`.
- Rejection reasons are exact strings: `no-manifest`, `invalid-manifest: <path>: <problem>`, `no-releases`, `no-matching-asset`, `unknown-games`, `blocked`.
- Worker secret: `GITHUB_TOKEN` (fine-grained, public read-only).
- Worker base URL comes from the existing `deps.shareBaseUrl`. Routes live under `/v1/catalog/`.
- Client index cache max age: 30 minutes.
- CLI exit codes: 0 means listed or valid, 1 means rejected or invalid, 2 means usage.
- Run vitest as `npm test` (already `--maxWorkers=2`), or `npx vitest run --maxWorkers=2 <file>`.
- UI copy, used verbatim:
  - First-owner confirm title: "Install from an unvetted author?" Body: "{owners} publish{es} on GitHub, not Thunderstore or Nexus Mods. HML doesn't review GitHub mods. Only install mods from authors you trust." Buttons: "Install" / "Cancel".
  - Blocked badge: "Blocked by HML: {reason}", with a "Remove" button.
  - Offline note: "Offline. Showing the catalog from {relative time}."

## Review Focus

1. **A malformed or hostile `hml.json`** (huge file, deep nesting, wrong types, a 50 MB README path, `javascript:` icon URL) must be rejected with a reason and must not crash or stall the crawl. Icon URLs must be `https:` only. Covered in Task 1 and Task 3 tests.
2. **A repo renamed after being blocked** must stay blocked, in the index and on clients. Covered in Task 4.
3. **Worker unreachable or returning garbage**: the Online tab shows the cached index with the offline note, or an empty state with a retry. It never throws into React. Covered in Task 6.
4. **A mod installed by pasted URL whose repo is later blocked** must stop auto-updating too, not only catalog installs. Covered in Task 7.
5. **A dependency cycle or a self-dependency** (`github:a/b` depends on `github:a/b`) must not loop forever, and must install each mod once. Covered in Task 7.

---

## File Structure

- `src/shared/hmlManifest.ts`: zod schema, `validateManifest`, `isKnownGameLabel`, `manifestJsonSchema()`.
- `src/shared/ghCatalog.ts`: shared types (`CatalogEntry`, `CatalogIndex`, `RepoStatus`, `BlockEntry`, `ServedBlocklist`) and `parseDependency`.
- `worker/src/catalog/listing.ts`: pure. Turns one crawled repo into a `RepoStatus`.
- `worker/src/catalog/github.ts`: GraphQL query string and response parsing to `CrawledRepo[]`.
- `worker/src/catalog/blocklist.ts`: id resolution, alias expansion and matching.
- `worker/src/catalog/crawl.ts`: resumable crawl state machine and KV writes.
- `worker/src/catalog/routes.ts`: `/v1/catalog/*` handlers.
- `worker/src/index.ts`, `worker/wrangler.jsonc`, `worker/README.md`: wiring, cron, docs.
- `src/main/ghcatalog/client.ts`: fetch and cache index and blocklist (disk, ETag).
- `src/main/ghcatalog/service.ts`: IPC services (`catList`, `catReadme`, `catPlanInstall`, `catInstall`, `catStatus`) and the blocklist view.
- `src/main/github/service.ts`: blocklist enforcement plus `assetPattern` refresh.
- `src/renderer/src/ghCatalogView.ts`: pure view helpers (search, sort, install state).
- `src/renderer/src/components/GithubBrowse.tsx` and `GithubCatalogDetail.tsx`: UI.
- `src/main/cli/commands.ts`: `validate`.
- `docs/catalog.md`, `.github/ISSUE_TEMPLATE/catalog-report.yml`, `README.md`, `src/renderer/src/cliAgentText.ts`: docs.

---

### Task 1: Shared manifest schema and validator

**Files:**
- Create: `src/shared/hmlManifest.ts`, `src/shared/ghCatalog.ts`
- Test: `tests/shared/hmlManifest.test.ts`

**Interfaces:**
- Produces:
  - `interface ManifestMod { id: string; name: string; description: string; games: string[]; tagPrefix?: string; assetPattern?: string; icon?: string; readme?: string; categories: string[]; dependencies: string[]; nsfw: boolean }`
  - `type ManifestResult = { ok: true; mods: ManifestMod[]; warnings: string[] } | { ok: false; error: string }`. `error` is the full reason string (`no-manifest`, `invalid-manifest: mods.0.id: ...`, `unknown-games`).
  - `validateManifest(text: string | null, isKnownGame: (label: string) => boolean): ManifestResult`
  - `isKnownGameLabel(label: string, tsSlugs: ReadonlySet<string>): boolean`
  - `manifestJsonSchema(): object` (from `z.toJSONSchema`)
  - `MANIFEST_MAX_BYTES = 65536`
  - In `ghCatalog.ts`:
    - `type Dependency = { kind: 'thunderstore'; fullName: string } | { kind: 'github'; owner: string; repo: string; id?: string }`
    - `parseDependency(s: string): Dependency | null`
    - the `CatalogEntry` fields exactly as in the spec's "Index entry", plus `games: string[]`
    - `interface CatalogIndex { game: string; builtAt: string; mods: CatalogEntry[] }`
    - `type RepoStatus = { owner: string; repo: string; crawledAt: string; listed: CatalogEntry[]; warnings: string[]; rejected?: string }`
    - `interface BlockEntry { target: string; reason: string; at: string }`
    - `interface ServedBlocklist { entries: { names: string[]; reason: string }[] }`. Here `names` are lowercase `owner` or `owner/repo` strings, including aliases.

- [ ] **Step 1: Write failing tests**, one `it` per case. A `KNOWN = (l) => isKnownGameLabel(l, new Set(['repo','stonewards']))` fixture.
  - `null` gives `{ok:false, error:'no-manifest'}`.
  - `'{'` gives an error starting with `invalid-manifest: `.
  - A text over 65536 bytes gives `invalid-manifest: (root): too large`.
  - `schema: 2` gives an error starting with `invalid-manifest: schema`.
  - Two mods without `tagPrefix` give an error containing `tagPrefix`.
  - Duplicate ids give an error containing `mods.1.id`.
  - `games: ['repo','bogus']` gives `ok` with `warnings` containing `bogus`.
  - `games: ['bogus']` gives `{ok:false, error:'unknown-games'}`.
  - `games: ['nexus-skyrimspecialedition']` gives `ok`.
  - `icon: 'javascript:alert(1)'` and `icon: 'http://x/y.png'` give `invalid-manifest`. `icon: 'https://x/y.png'` and `icon: 'icons/a.png'` give `ok`.
  - Absolute paths or `..` in `icon` or `readme` give `invalid-manifest`.
  - Defaults are applied: `categories: []`, `dependencies: []`, `nsfw: false`.
  - `parseDependency`:
    - `'BepInEx-BepInExPack-5.4.2100'` gives thunderstore.
    - `'github:a/b'` gives `{kind:'github',owner:'a',repo:'b'}`.
    - `'github:a/b/c'` sets id `'c'`.
    - `'github:'` and `'nope'` give `null`.
  - `manifestJsonSchema()` has `properties.mods`.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=2 tests/shared/hmlManifest.test.ts`. Expect FAIL (module not found).
- [ ] **Step 3: Implement both files.** Use zod `safeParse`. Format the first issue as `invalid-manifest: ${issue.path.join('.') || '(root)'}: ${issue.message}`. Reuse the owner and repo regexes from `src/main/github/url.ts` for `github:` deps by moving `OWNER_RE`/`REPO_RE` into `src/shared/ghCatalog.ts` and importing them back in `url.ts`.
- [ ] **Step 4: Run the tests.** Expect PASS. Then run `npm run typecheck:node`. Expect no errors.
- [ ] **Step 5: Commit** `feat(catalog): hml.json manifest schema and validator`.

### Task 2: Listing logic (one repo to RepoStatus)

**Files:**
- Create: `worker/src/catalog/listing.ts`
- Test: `tests/worker/catalogListing.test.ts`

**Interfaces:**
- Consumes: `validateManifest`, `CatalogEntry`, `RepoStatus` (Task 1); `tagPrefix`, `tagVersion`, `samePrefix` from `src/shared/ghTag.ts`. Move `matchesAssetPattern` from `src/main/github/assets.ts` to `src/shared/ghTag.ts` and re-export it from `assets.ts`. It must be pure.
- Produces:
  - `interface CrawledRelease { tag: string; draft: boolean; prerelease: boolean; publishedAt: string; assets: { name: string; size: number; downloads: number }[] }`
  - `interface CrawledRepo { id: string; ownerId: string; owner: string; repo: string; stars: number; createdAt: string; ownerAvatar: string; defaultBranch: string; manifest: string | null; manifestTooLarge?: true; releases: CrawledRelease[]; archived: boolean }`. When `manifestTooLarge` is set, `buildStatus` rejects the repo with `invalid-manifest: (root): too large` before anything else.
  - `buildStatus(r: CrawledRepo, isKnownGame: (l: string) => boolean, now: string): RepoStatus`

- [ ] **Step 1: Write failing tests:**
  - With no manifest, the status is `rejected:'no-manifest'`.
  - With a valid single mod and only draft releases, it's `rejected:'no-releases'`.
  - The release asset must be a `.zip` (or match `assetPattern`). A release with only `.txt` assets gives `rejected:'no-matching-asset'`.
  - In a monorepo with prefixes `a-v` and `b-v`, each entry's `latest.tag` is the newest of its own prefix, by `publishedAt`.
  - Pre-release-only gives a listed entry with `latest.prerelease === true`. When a stable release exists, it's preferred over a newer pre-release.
  - `downloads` is the sum of matching assets across that mod's releases.
  - A relative `icon` resolves to `https://raw.githubusercontent.com/{owner}/{repo}/{defaultBranch}/{path}`. A missing icon falls back to `ownerAvatar`. A relative `readme` resolves the same way. A missing readme uses `README.md`.
  - When one mod of two has no releases, the other is listed and `warnings` names the first.
  - Manifest `warnings` (unknown game) are passed through.
- [ ] **Step 2: Run the tests.** Expect FAIL.
- [ ] **Step 3: Implement `buildStatus`.** A repo is rejected only when no mod gets listed. The rejection is then the first mod's reason, or the manifest's error. `key` is `${owner}/${repo}/${id}`. `latest.version` is `tagVersion(tag)`.
- [ ] **Step 4: Run the tests.** Expect PASS.
- [ ] **Step 5: Commit** `feat(worker): catalog listing rules`.

### Task 3: GraphQL fetch and parse

**Files:**
- Create: `worker/src/catalog/github.ts`
- Test: `tests/worker/catalogGithub.test.ts`, fixture `tests/fixtures/gh-graphql-page.json`

**Interfaces:**
- Produces:
  - `SEARCH_QUERY: string`. Its `search(query:"topic:hml-mod archived:false fork:true", type:REPOSITORY, first:100, after:$cursor)` returns per repo:
    - `databaseId` and `owner { login avatarUrl ... on Node { id } }`;
    - `name`, `stargazerCount`, `createdAt`, `isArchived`, `defaultBranchRef { name }`;
    - `object(expression:"HEAD:hml.json") { ... on Blob { text byteSize } }`;
    - `releases(first:30, orderBy:{field:CREATED_AT, direction:DESC}) { nodes { tagName isDraft isPrerelease publishedAt releaseAssets(first:20) { nodes { name size downloadCount } } } }`.

    The query also selects `issueCount` (repository count) and `pageInfo`.
  - `fetchSearchPage(fetchFn: typeof fetch, token: string, cursor: string | null): Promise<{ repos: CrawledRepo[]; nextCursor: string | null; total: number }>`
  - `class GhGraphqlError extends Error { status: number }`
- [ ] **Step 1: Write failing tests** with a fake `fetch` returning the fixture:
  - It's a POST to `https://api.github.com/graphql` with `authorization: bearer <token>` and a `user-agent` header.
  - Repos map to `CrawledRepo`.
  - A Blob with `byteSize` over 65536 maps to `manifest: null, manifestTooLarge: true`.
  - `pageInfo.hasNextPage:false` gives `nextCursor: null`.
  - An HTTP 502 throws `GhGraphqlError` with status 502.
  - A body with `errors` and no `data` throws.
- [ ] **Step 2: Run the tests.** Expect FAIL.
- [ ] **Step 3: Implement it.** Make one fetch per call. Validate the response shape defensively and skip malformed nodes. Don't throw on a single bad node.
- [ ] **Step 4: Run the tests.** Expect PASS.
- [ ] **Step 5: Commit** `feat(worker): GitHub GraphQL catalog search`.

### Task 4: Blocklist resolution

**Files:**
- Create: `worker/src/catalog/blocklist.ts`
- Test: `tests/worker/catalogBlocklist.test.ts`

**Interfaces:**
- Consumes: `BlockEntry`, `ServedBlocklist` (Task 1), `CrawledRepo` (Task 2).
- Produces:
  - `interface BlockState { ids: Record<string, { kind: 'owner' | 'repo'; reason: string; names: string[] }> }`. Keys are GitHub node ids (owner) or `databaseId` (repo).
  - `updateBlockState(entries: BlockEntry[], state: BlockState, seen: CrawledRepo[]): BlockState`
    - Matches entry targets case-insensitively against `seen` names to learn ids.
    - Adds any new name seen for a known id to `names`.
    - Drops ids whose entry was removed from `entries`.
  - `isBlocked(r: CrawledRepo, entries: BlockEntry[], state: BlockState): string | null` returns the reason. It matches by name or by id.
  - `serveBlocklist(entries: BlockEntry[], state: BlockState): ServedBlocklist`
- [ ] **Step 1: Write failing tests:**
  - An entry `evil` blocks `evil/x`.
  - An entry `evil/x` doesn't block `evil/y`.
  - Rename case: crawl 1 sees `evil/x` (id 7) blocked by `evil/x`. Crawl 2 sees id 7 as `evil/renamed`. `isBlocked` gives the reason, and `serveBlocklist` names include both `evil/x` and `evil/renamed`.
  - An owner rename tracked by owner node id blocks the new login's repos.
  - Removing the entry unblocks the repo and drops the state.
  - Matching is case-insensitive.
- [ ] **Step 2: Run the tests.** Expect FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the tests.** Expect PASS.
- [ ] **Step 5: Commit** `feat(worker): blocklist that survives renames`.

### Task 5: Resumable crawl, routes, cron wiring

**Files:**
- Create: `worker/src/catalog/crawl.ts`, `worker/src/catalog/routes.ts`
- Modify:
  - `worker/src/index.ts`: extend `KvLike` with `get(key, 'text')` and `put(key, string)`; add `GITHUB_TOKEN: string` and `CATALOG_LIMITER` to `Env`; route `/v1/catalog/` before the 404; export a `scheduled` handler.
  - `worker/wrangler.jsonc`: `"triggers": { "crons": ["*/30 * * * *"] }`, plus `CATALOG_LIMITER` (namespace `5005`, 120/60).
  - `worker/README.md`: catalog routes, KV keys, blocklist editing with `npx wrangler@4 kv key put --binding PROFILES catalog:blocklist '<json>'`, and `wrangler secret put GITHUB_TOKEN`.
- Test: `tests/worker/catalogCrawl.test.ts`, `tests/worker/catalogRoutes.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - KV keys:
    - `catalog:state`: `{ cursor: string | null; pass: Record<string, RepoStatus>; total: number; blocks: BlockState }`
    - `catalog:index:<game>`: a `CatalogIndex` JSON
    - `catalog:status`: `Record<"owner/repo" lowercase, RepoStatus>`
    - `catalog:blocklist`: `BlockEntry[]`, written by hand
    - `catalog:games`: `{ fetchedAt: string; slugs: string[] }`
    - `catalog:hash:<key>`: the SHA-256 of what was last written to `<key>`
  - `runCrawl(env: Env, fetchFn: typeof fetch, now: () => number): Promise<{ pages: number; repos: number; finishedPass: boolean; writes: number }>`
  - `handleCatalog(req: Request, env: Env, path: string): Promise<Response>`. Routes:
    - `GET /v1/catalog/:game` sends an ETag (the hash) and handles `If-None-Match`. It returns `304`, or `200 {game, builtAt, mods}`. An unknown game is `200` with `mods: []`.
    - `GET /v1/catalog/status/:owner/:repo` returns `200` with the RepoStatus, or `404 not-crawled`.
    - `GET /v1/catalog/blocklist` returns a `ServedBlocklist`.
    - `GET /v1/catalog/schema.json` returns `manifestJsonSchema()`.

    All routes use `cache-control: public, max-age=300` and the `CATALOG_LIMITER` per IP (`429 rate-limited`). Non-GET requests get `405`.
- [ ] **Step 1: Write failing crawl tests** using the in-memory KV pattern from `tests/worker/sync.test.ts`, a fake fetch for GraphQL, and the ecosystem fixture `tests/fixtures/ecosystem-min.json`:
  - With 2 pages total, one run does both pages, writes the indexes, and sets `finishedPass:true`.
  - With 5 pages, run 1 does 3 pages, saves the cursor and writes no index. Run 2 finishes, then writes.
  - A second identical full pass gives `writes === 0`. The `catalog:state` write is skipped when it's unchanged.
  - A blocked repo is absent from the index, and its status is `rejected:'blocked'`.
  - A mod with `games:['repo','stonewards']` appears in both indexes.
  - A GraphQL 502 mid-pass keeps the cursor, and the next run resumes from it.
  - The ecosystem slugs are refetched only when `catalog:games.fetchedAt` is over 24 hours old.
- [ ] **Step 2: Write failing route tests:**
  - ETag then `304`.
  - An unknown game gives an empty list.
  - Status route `404`.
  - Blocklist served with aliases.
  - Limiter `429`.
  - `POST` gives `405`.
  - Existing `/v1/profiles` and `/v1/sync` tests still pass.
- [ ] **Step 3: Run the tests.** Expect FAIL.
- [ ] **Step 4: Implement it.** Hash with `crypto.subtle.digest('SHA-256', ...)`. Write a key only when its hash differs from `catalog:hash:<key>`. Games that had an index last pass but none now get an empty index written. Log `{pages, repos, writes, ms}` with `console.log` each run, and a warning when `total > 1000`.
- [ ] **Step 5: Run** `npx vitest run --maxWorkers=2 tests/worker`. Expect all PASS. Then run `npm run typecheck:node`.
- [ ] **Step 6: Commit** `feat(worker): resumable catalog crawl and /v1/catalog routes`.

### Task 6: App catalog client and IPC

**Files:**
- Create: `src/main/ghcatalog/client.ts`, `src/main/ghcatalog/service.ts`
- Modify:
  - `src/main/store/paths.ts`: `catalogCache(label: string): string` → `cache/ghcatalog/<label>.json`, and `catalogBlocklist` → `cache/ghcatalog-blocklist.json`.
  - `src/shared/types.ts`: `Settings.trustedCatalogOwners: string[]`, default `[]` wherever the settings defaults live.
  - `src/shared/ipc.ts`: new methods, plus their `true` entries in the channel map.
  - `src/main/services.ts`: wiring.
  - `src/preload/index.ts`: only if channels are listed explicitly there.
- Test: `tests/main/ghcatalog/client.test.ts`, `tests/main/ghcatalog/service.test.ts`

**Interfaces:**
- Consumes: `CatalogIndex`, `ServedBlocklist`, `RepoStatus` (Task 1); `deps.fetch`, `deps.shareBaseUrl`, `deps.now`.
- Produces (IPC on `HmlApi`):
  - `catList(game: string, force?: boolean): Promise<CatListResult>`, where `type CatListResult = { mods: CatalogEntry[]; fetchedAt: string | null; offline: boolean }`.
  - `catReadme(game: string, key: string): Promise<string>` returns raw markdown from the entry's `readme` URL, capped at 1 MB. Only `https://raw.githubusercontent.com/` is allowed.
  - `catPlanInstall(game: string, profileId: string, key: string): Promise<CatInstallPlan>` (implemented in Task 7).
  - `catInstall(game: string, profileId: string, key: string, confirmedOwners: string[]): Promise<CatInstallResult>` (implemented in Task 7).
  - `catStatus(ownerRepo: string): Promise<RepoStatus | null>`.
- Produces (in-process, for Task 7):
  - `blockedReason(owner: string, repo: string): Promise<string | null>` uses the cached blocklist and refetches it when it's older than 30 minutes. Offline, it uses the last cached copy. It's case-insensitive.
  - `cachedEntry(game: string, owner: string, repo: string, prefix: string): Promise<CatalogEntry | null>` reads the disk cache only, with no fetch.

- [ ] **Step 1: Write failing client tests** with a fake fetch and a temp dir:
  - The first call fetches and writes the cache.
  - A call within 30 minutes makes no fetch.
  - After 30 minutes it sends `If-None-Match` and treats `304` as the cached copy with a refreshed `fetchedAt`.
  - On a network error with a cache, it returns `{offline:true}` with the cached mods.
  - On a network error with no cache, it returns `{mods:[], fetchedAt:null, offline:true}`.
  - A garbage JSON body counts as offline. The cache isn't overwritten.
  - `force` skips the 30-minute check.
  - `blockedReason('Evil','X')` matches the entry `evil/x`. An owner-level entry `evil` matches any repo.
- [ ] **Step 2: Write failing service tests:**
  - `catReadme` rejects non-raw hosts and caps the size.
  - `catStatus` returns `null` on `404`.
- [ ] **Step 3: Run the tests.** Expect FAIL.
- [ ] **Step 4: Implement it.** Use `readJson` and `writeJsonAtomic` from `src/main/store/json`.
- [ ] **Step 5: Run the tests, then** `npm run typecheck`. Expect PASS.
- [ ] **Step 6: Commit** `feat(catalog): app catalog client and IPC`.

### Task 7: Catalog install, dependencies, blocklist enforcement

**Files:**
- Modify:
  - `src/main/ghcatalog/service.ts`: `catPlanInstall` and `catInstall`.
  - `src/main/github/service.ts`: add `blockedReason` and `cachedEntry` to `GhContext`; skip blocked mods in `checkUpdates`, `update`, `autoUpdateProfile` and `installRelease`; refresh `assetPattern`.
  - `src/shared/types.ts`: `InstalledMod`-adjacent view type `GhBlocked`.
  - `src/shared/ipc.ts`: `ghBlocked`.
  - `src/main/services.ts`: pass the context.
- Test: `tests/main/ghcatalog/install.test.ts`, plus additions in `tests/main/github/` (the existing service test file there)

**Interfaces:**
- Consumes: `ghInstallWith(game, profileId, url, asset?, opts?: GhInstallOptions)` from `createGithubServices`; the existing Thunderstore dependency install that `ghInstall`'s callers use (`installMissingDeps` or equivalent in `services.ts`, which handles `ModDepsDialogs`); and `CatalogEntry`, `parseDependency`.
- Produces:
  - `interface CatInstallPlan { mods: CatalogEntry[]; thunderstore: string[]; unavailable: string[]; untrustedOwners: string[] }`
    - `mods` are the GitHub mods to install in dependency order, the target last.
    - Mods already installed at the same owner/repo/prefix are omitted.
  - `type CatInstallResult = { kind: 'installed'; installed: InstalledMod[] } | { kind: 'needs-confirm'; owners: string[] } | { kind: 'blocked'; reason: string }`
  - `catInstall` calls `ghInstallWith(game, profileId, \`https://github.com/${owner}/${repo}\`, undefined, { tagPrefix, assetPattern, followNewestTag: true })` for each mod in `plan.mods`, then installs the Thunderstore deps through the existing path. It adds the confirmed owners to `Settings.trustedCatalogOwners`, stored lowercase.
  - `ghBlocked(game: string, profileId: string): Promise<Record<string /* modId */, string /* reason */>>`
- [ ] **Step 1: Write failing tests:**
  - A plan for A, which depends on `github:o/b` and a Thunderstore dep, gives `mods:[B, A]` and `thunderstore:[...]`.
  - Cycle: A depends on B and B on A. Each appears once, and the call terminates.
  - A self-dependency is ignored.
  - A dependency on an unlisted repo goes in `unavailable`.
  - `github:o/mono` without an id, where the repo has 2 mods, goes in `unavailable`.
  - Untrusted owners lists the owners of the target and its deps that aren't in `trustedCatalogOwners`.
  - `catInstall` with missing confirmations returns `needs-confirm` and installs nothing.
  - With confirmations, it calls `ghInstallWith` in order with `tagPrefix` and `assetPattern`, and the owners are saved.
  - A blocked target returns `{kind:'blocked'}` before anything is installed.
- [ ] **Step 2: Write failing GitHub-service tests:**
  - A URL-installed mod whose repo is blocked is skipped by `checkUpdates` and `autoUpdateProfile`, whatever its mode (`auto`, `notify`).
  - `update` with its id throws `Blocked by HML: <reason>`.
  - `ghBlocked` returns it.
  - `assetPattern` refresh: the saved config `assetPattern: 'Old-{version}.zip'` and a cached entry `assetPattern: 'New-{version}.zip'` give a saved `'New-{version}.zip'` after `checkUpdates`.
  - A changed `tagPrefix` in the cache is ignored. The same refresh happens in `autoUpdateProfile`. Put it in `latestFor`, which both use.
- [ ] **Step 3: Run the tests.** Expect FAIL.
- [ ] **Step 4: Implement it.** Resolve dependencies breadth-first with a `visited` set keyed by `owner/repo/id`, using the cached index for `game` (`catList` without force). The blocklist check comes first.
- [ ] **Step 5: Run** `npm test`, then `npm run typecheck`. Expect PASS.
- [ ] **Step 6: Commit** `feat(catalog): install with dependencies; blocklist stops updates`.

### Task 8: Renderer, GitHub Online source

**Files:**
- Create: `src/renderer/src/ghCatalogView.ts`, `src/renderer/src/components/GithubBrowse.tsx`, `src/renderer/src/components/GithubCatalogDetail.tsx`
- Modify:
  - `src/renderer/src/store.ts`: `OnlineSource` adds `'github'`.
  - `src/renderer/src/customView.ts`: `sourcesFor`'s `online` type includes `'github'` and always appends it. `githubPrimary` stays `true` only when neither Thunderstore nor Nexus applies.
  - `src/renderer/src/components/Browse.tsx`: `SOURCES` adds `{ value: 'github', label: 'GitHub' }` and mounts `GithubBrowse`.
  - `src/renderer/src/components/ModList.tsx`: blocked badge.
- Test: `tests/renderer/ghCatalogView.test.ts`, `tests/renderer/customView.test.ts` (update)

**Interfaces:**
- Consumes: `catList`, `catReadme`, `catPlanInstall`, `catInstall`, `ghBlocked` (Tasks 6–7).
- Produces:
  - `filterCatalog(mods: CatalogEntry[], q: { text: string; category: string | null; sort: CatSort; nsfw: boolean }): CatalogEntry[]`, with `type CatSort = 'updated' | 'downloads' | 'stars' | 'newest'`.
  - `catInstallState(entry: CatalogEntry, installed: InstalledMod[]): 'none' | 'installed' | 'update'`. Matching is by `source.owner/repo` (case-insensitive) and `samePrefix(tagPrefix(source.tag), entry.tagPrefix ?? '')`. The state is `update` when `isNewerTag(entry.latest.tag, source.tag)`. Move `isNewerTag` to `src/shared/ghTag.ts` if it isn't importable from the renderer.
  - `catCategories(mods: CatalogEntry[]): string[]`
- [ ] **Step 1: Write failing tests** for the view helpers:
  - Text matches name, description, owner and category, case-insensitively.
  - `nsfw:false` hides nsfw entries.
  - Each sort orders correctly: `updated` uses `latest.publishedAt`, `newest` uses `repoCreatedAt`.
  - Install state covers a URL-installed mod (shows `installed`), an older tag (`update`), and another prefix in the same repo (`none`).
  - `sourcesFor` now includes `'github'` for Thunderstore, Nexus and custom games.
- [ ] **Step 2: Run the tests.** Expect FAIL.
- [ ] **Step 3: Implement the helpers, then the components.**
  - Follow `NexusBrowse.tsx` and `PackageDetail.tsx` for layout, icons, `relativeTime` and `compactCount`.
  - The detail view renders the README with the existing `Markdown` component and shows stars, repo age, last release and downloads.
  - It has "View on GitHub" and "Report" buttons. Report opens `https://github.com/darkharasho/hml/issues/new?template=catalog-report.yml&title=Report: {owner}/{repo}` through the existing external-link helper.
  - Install flow: `catPlanInstall` → if `untrustedOwners` is non-empty, show the confirm dialog with the exact copy from Global Constraints → `catInstall(..., owners)` → reuse the existing install toasts and the deps dialog for `unavailable`.
  - Respect `useSyncLocked`, as `Browse.tsx` does.
  - Show the offline note when `offline`.
  - The empty state reads: "No GitHub mods for this game yet." with a "How to list a mod" link to `docs/catalog.md` on GitHub.
  - ModList: when `ghBlocked` names the mod, show the badge copy plus a Remove button that calls the existing uninstall.
- [ ] **Step 4: Run** `npm test`, then `npm run typecheck` and `npm run lint`. Expect PASS.
- [ ] **Step 5: Check it in the real app** with the `run` skill. Point `HML_SHARE_URL` at a local `npx wrangler@4 dev` with a seeded `catalog:index:repo`. Confirm browse, detail and install work, and that the Dev profile shows the mod. Screenshot it.
- [ ] **Step 6: Commit** `feat(catalog): GitHub source in the Online tab`.

### Task 9: CLI `hml validate`

**Files:**
- Modify:
  - `src/main/cli/commands.ts`: add `validate` to `CLI_USAGE` and the switch. Extend `CliPort` with `catStatus` and `knownGameLabel(label: string): Promise<boolean>`, the latter backed by the app's catalog plus the `nexus-` rule.
  - `src/main/index.ts`: `cliPort` wiring.
  - `src/renderer/src/cliAgentText.ts`: one line on `hml validate` for mod authors.
- Test: `tests/main/cli/` (the existing commands test file)

**Interfaces:**
- Consumes: `validateManifest` (Task 1), `catStatus` (Task 6).
- Produces: `hml validate [path | owner/repo] [--json]`.
  - With no argument, it reads `<cwd>/hml.json`. A path argument may point at a file or a directory containing `hml.json`.
  - An `owner/repo` argument (it matches the owner/repo regexes and isn't an existing path) prints the Worker status.
  - Usage line: `validate [path|owner/repo]         Check an hml.json, or a repo's GitHub catalog listing`.
- [ ] **Step 1: Write failing tests:**
  - A valid file gives code 0, and stdout lists the mod ids and games.
  - Warnings go to stderr with code 0.
  - An invalid file gives code 1, and stderr has the exact reason.
  - A missing file gives code 1 with `No hml.json in <dir>`.
  - `owner/repo` that's listed gives code 0 with the crawl time.
  - `owner/repo` that's rejected gives code 1 with the reason.
  - `owner/repo` that's not crawled gives code 1 with `Not in the catalog yet. Add the hml-mod topic; the catalog updates every 30 minutes.`
  - Two arguments give code 2.
  - `--json` prints the `ManifestResult` or `RepoStatus`.
- [ ] **Step 2: Run the tests.** Expect FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the tests and typecheck.** Expect PASS.
- [ ] **Step 5: Commit** `feat(cli): hml validate`.

### Task 10: Author docs and report template

**Files:**
- Create: `docs/catalog.md`, `.github/ISSUE_TEMPLATE/catalog-report.yml`
- Modify: `README.md` (one link under the GitHub feature section)

- [ ] **Step 1: Write `docs/catalog.md`.** It covers:
  - the `hml-mod` topic and the required `hml.json`;
  - a field table matching Task 1 limits exactly;
  - one single-mod example and one monorepo example (`tagPrefix` per mod);
  - `"$schema": "https://hml-share.project96.workers.dev/v1/catalog/schema.json"`;
  - the listing rules and rejection reasons (exact strings from Global Constraints);
  - "updates every 30 minutes; a full pass can take longer for a large catalog";
  - `hml validate`;
  - how to report or appeal a block.
- [ ] **Step 2: Write the issue template** with fields: repo URL (required), what's wrong (dropdown: malware, stolen or reuploaded, broken, other), and details.
- [ ] **Step 3: Validate both examples in the doc** by saving each to a temp dir and running `npx tsx -e` with `validateManifest`, or the dev CLI (`hml validate <tmp>`). Expect exit 0 for both.
- [ ] **Step 4: Commit** `docs: GitHub catalog author guide and report template`.

---

## Deployment (after merge, by the user or with their go-ahead)

1. Run `cd worker && npx wrangler@4 secret put GITHUB_TOKEN`, using a fine-grained token with public read-only access.
2. Run `npx wrangler@4 kv key put --binding PROFILES catalog:blocklist '[]'`.
3. Run `npx wrangler@4 deploy`. Check the next cron run in the Worker logs (`pages`, `repos`, `writes`, `ms`).
4. Add the `hml-mod` topic and an `hml.json` to `REPOsitory` and `stonewards-upgrade-queue` as first listings. Confirm with `hml validate darkharasho/<repo>`.
