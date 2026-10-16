# HML Thunderstore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Browse, search, install (with dependencies) and update Thunderstore mods for the current game's profile.

**Architecture:** Main process downloads a community's package index (gzipped JSON array of gzipped chunk URLs), slims it to a lean `TsPackage[]`, caches it on disk, and searches it in memory; the renderer only ever receives one page of results over IPC. Installs resolve `Author-Name-Version` dependencies into an ordered list, download each zip into a cache and feed it to the existing `installZip` with package id `Author-Name`. Updates compare installed Thunderstore mods against the cached index.

**Tech Stack:** Electron main (Node `zlib`, `fetch`), existing `installZip`/profiles/services from plan 1, React + zustand + Tailwind renderer.

**Spec:** `docs/superpowers/specs/2026-10-15-hml-design.md` (section "Thunderstore (plan 2)" and "Mod identity").

## Global Constraints

- Vitest always runs with `--maxWorkers=2`.
- The renderer never imports Node modules. Every privileged action goes through `HmlApi` (`src/shared/ipc.ts`); new methods go in `METHOD_TABLE`.
- Every JSON write uses `writeJsonAtomic` (`src/main/store/json.ts`).
- Data root is injected (`AppPaths`); tests use a temp dir and an injected `fetch`. No test touches the network.
- Thunderstore mods are recorded with `source: { kind: 'thunderstore', fullName: 'Author-Name' }` and installed with `installZip(..., { packageId: fullName, name, version })`, so the mod id is `Author-Name` (fixes the plan-1 parked id-collision minor for Thunderstore mods).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Platforms: Windows + Linux.

### Facts verified against the live API (2026-10-15)

- `GameDef.packageIndex` is e.g. `https://thunderstore.io/c/repo/api/v1/package-listing-index/`. It 302-redirects to a `ccdn.thunderstore.io` blob served as `application/octet-stream`, **gzip-compressed** (not `Content-Encoding`), whose JSON is an array of chunk URLs. Chunk URLs are content-addressed (`…/sha256/<hash>…blob`), so an unchanged URL means unchanged content.
- Each chunk is a gzipped JSON array of packages: `{ name, full_name, owner, package_url, date_updated, rating_score, is_pinned, is_deprecated, has_nsfw_content, categories: string[], versions: [...] }`; versions are newest first: `{ name, full_name, description, icon, version_number, dependencies: string[], download_url, downloads, date_created, website_url, is_active, file_size }`.
- Dependency strings are `Owner-Name-x.y.z` (e.g. `BepInEx-BepInExPack-5.4.2100`). `download_url` is `https://thunderstore.io/package/download/<owner>/<name>/<ver>/` and redirects to `https://ccdn.thunderstore.io/live/repository/packages/<full_name>.zip`. Icons are on `ccdn.thunderstore.io` (already allowed by the CSP).
- R.E.P.O. has ~2k packages / 12k versions per chunk, ~3 chunks (≈13 MB JSON per chunk raw); large communities are bigger, so slimming and paging are required.

## Review Focus

1. Thunderstore unreachable: with a cache, Browse shows cached results and a "showing cached list" notice; with no cache, Browse shows a readable error and a Retry button — never a crash or blank tab. (Task 1 tests, Task 6 UI)
2. Very large communities (≈50k packages): a search must return in well under a second and IPC must carry one page, not the list. (Task 2 test with 50k synthetic packages)
3. Dependency graphs with cycles, the same dependency at two versions, and dependencies missing from the index: no infinite loop, highest required version wins, missing ones are reported and the rest install. (Task 3 tests)
4. A download that is not a zip (HTML error page, truncated body, HTTP 404): readable error naming the package, nothing cached, nothing written to the profile. (Task 4 tests)
5. Failure halfway through a dependency chain: packages installed before the failure stay installed and recorded, the error names the failing package, the profile manifest stays valid. (Task 4 tests)

---

## File Structure

- `src/shared/types.ts` — add `TsVersion`, `TsPackage`, `TsQuery`, `TsSearchResult`, `TsInstallResult`, `ModUpdate`, `HmlEvent`.
- `src/main/store/paths.ts` — add `tsIndexCache(label)`.
- `src/main/thunderstore/packageIndex.ts` — fetch, slim, cache, load the package list (Task 1).
- `src/main/thunderstore/search.ts` — pure search/filter/sort/page (Task 2).
- `src/main/thunderstore/resolve.ts` — dependency parsing, version compare, install resolution, update detection (Task 3).
- `src/main/thunderstore/download.ts` — cached zip download with validation (Task 4).
- `src/main/services.ts`, `src/main/index.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/renderer/src/env.d.ts` — wiring and events (Tasks 4–5).
- `src/renderer/src/store.ts`, `src/renderer/src/components/ModList.tsx`, new `src/renderer/src/components/Browse.tsx`, `src/renderer/src/components/PackageDetail.tsx` — UI (Task 6).
- Tests mirror under `tests/main/thunderstore/` and `tests/main/services.test.ts`.

## Shared types (added in Task 1, used by all later tasks)

```ts
export interface TsVersion {
  version: string            // version_number
  dependencies: string[]     // "Owner-Name-x.y.z"
  downloadUrl: string
  downloads: number
  fileSize: number
  dateCreated: string
}
export interface TsPackage {
  fullName: string           // "Owner-Name"
  owner: string
  name: string
  description: string        // from newest version
  iconUrl: string            // from newest version
  websiteUrl: string         // from newest version, '' if none
  packageUrl: string
  categories: string[]
  rating: number
  totalDownloads: number     // sum over kept versions
  dateUpdated: string
  isPinned: boolean
  isDeprecated: boolean
  nsfw: boolean
  versions: TsVersion[]      // newest first, only is_active versions
}
export type TsSort = 'top' | 'downloads' | 'updated' | 'name'
export interface TsQuery {
  text: string
  categories: string[]       // package must have every listed category
  sort: TsSort
  includeDeprecated: boolean
  includeNsfw: boolean
  offset: number
  limit: number              // clamped to 1..100
}
export interface TsSearchResult {
  items: TsPackage[]
  total: number
  categories: string[]       // all categories in the community, sorted
  fetchedAt: string
  stale: boolean             // true when the refresh failed and cached data is shown
}
export interface TsInstallResult {
  installed: InstalledMod[]
  skipped: string[]          // fullNames already satisfied
  missing: string[]          // dependency strings not found in the index
}
export interface ModUpdate {
  modId: string
  fullName: string
  current: string
  latest: string
}
export type HmlEvent = { type: 'progress'; message: string; done: number; total: number }
```

---

### Task 1: Package index — fetch, slim, cache

**Files:**
- Modify: `src/shared/types.ts` (types above), `src/main/store/paths.ts`
- Create: `src/main/thunderstore/packageIndex.ts`
- Test: `tests/main/thunderstore/packageIndex.test.ts`, fixtures `tests/fixtures/ts-chunk-a.json`, `tests/fixtures/ts-chunk-b.json` (3–4 hand-written raw packages each, using the live field names above, including one `is_active: false` version and one deprecated package)

**Interfaces:**
- Consumes: `writeJsonAtomic`, `readJson` (`src/main/store/json.ts`), `AppPaths`.
- Produces:
  - `paths.tsIndexCache(label: string): string` → `<root>/cache/thunderstore/<label>.json`
  - `slimPackage(raw: unknown): TsPackage | null` — null for malformed entries or packages with no active versions.
  - `decodeMaybeGzip(buf: Uint8Array): unknown` — gunzips when the body starts with `1f 8b`, else parses as UTF-8 JSON.
  - `interface TsIndex { packages: TsPackage[]; chunkUrls: string[]; fetchedAt: string }`
  - `loadPackageIndex(opts: { paths: AppPaths; label: string; indexUrl: string; fetch: typeof fetch; now?: () => number; maxAgeMs?: number; force?: boolean }): Promise<TsIndex & { stale: boolean }>`

- [ ] **Step 1: Write failing tests** (gzip fixtures in-test with `zlib.gzipSync`; fake fetch maps URL → body)
  - `slimPackage` maps fields: `fullName`, `iconUrl`/`description`/`websiteUrl` from `versions[0]`, drops `is_active: false` versions, `totalDownloads` is the sum of kept versions, returns null for `{}` and for a package whose versions are all inactive.
  - `decodeMaybeGzip` handles gzipped and plain JSON bodies.
  - fetches index then both chunks, merges packages, writes cache with `chunkUrls` and `fetchedAt = new Date(now()).toISOString()`.
  - fresh cache (age < `maxAgeMs`, default `3_600_000`) → no fetch at all.
  - stale cache and the index returns the same chunk URLs → only the index is fetched (no chunk requests), `fetchedAt` updated, packages unchanged.
  - `force: true` ignores freshness but still reuses unchanged chunk list.
  - index or chunk fetch throws / non-OK with a cache present → returns cached data with `stale: true`, cache file unchanged.
  - fetch fails with no cache → rejects with `Error` whose message is `Couldn't reach Thunderstore. Check your connection and try again.`
  - a malformed package inside a chunk is skipped, the rest load.
  - corrupt cache file is treated as missing.
- [ ] **Step 2:** `npx vitest run tests/main/thunderstore/packageIndex.test.ts --maxWorkers=2` → FAIL (module missing).
- [ ] **Step 3: Implement.** Chunks are fetched with at most 3 in flight. A non-OK response is a failure. Validate that the index decodes to an array of strings and each chunk to an array; anything else is a failure (fall back as above).
- [ ] **Step 4:** run the test → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(thunderstore): package index fetch, slim and cache`

---

### Task 2: Search

**Files:**
- Create: `src/main/thunderstore/search.ts`
- Test: `tests/main/thunderstore/search.test.ts`

**Interfaces:**
- Consumes: `TsPackage`, `TsQuery` (Task 1).
- Produces: `searchPackages(pkgs: TsPackage[], q: TsQuery): { items: TsPackage[]; total: number }` and `allCategories(pkgs: TsPackage[]): string[]`.

Rules:
- Text: split on whitespace, lowercase; every term must appear in `name`, `owner`, `fullName` or `description` (case-insensitive). Underscores in names match spaces in the query (`"more upgrades"` matches `MoreUpgrades` and `More_Upgrades` — compare against the name with `_` removed as well as spaced).
- Deprecated excluded unless `includeDeprecated`; `nsfw` excluded unless `includeNsfw`.
- Sort `top`: pinned first, then `rating` desc, then `totalDownloads` desc. `downloads`: `totalDownloads` desc. `updated`: `dateUpdated` desc. `name`: `name` asc, case-insensitive. Ties keep index order.
- `total` counts all matches; `items` is `slice(offset, offset + limit)` with `limit` clamped to 1..100 and `offset` clamped ≥ 0.

- [ ] **Step 1: Failing tests** for each rule above, plus: `allCategories` returns the sorted unique set; **performance**: 50 000 synthetic packages, query `"lib"` with sort `top` completes in < 500 ms and returns ≤ `limit` items.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** Precompute nothing across calls (keep it pure); one filter pass then sort.
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5: Commit** `feat(thunderstore): local package search`

---

### Task 3: Dependency resolution and update detection

**Files:**
- Create: `src/main/thunderstore/resolve.ts`
- Test: `tests/main/thunderstore/resolve.test.ts`

**Interfaces:**
- Consumes: `TsPackage`, `InstalledMod`, `ModUpdate`.
- Produces:
  - `parseDependency(dep: string): { fullName: string; version: string } | null` — splits on the **last** `-`; version must match `/^\d+(\.\d+)*$/`, else null.
  - `compareVersions(a: string, b: string): number` — numeric per dot-segment, missing segments are 0.
  - `interface PlannedPackage { fullName: string; name: string; version: string; downloadUrl: string }`
  - `resolveInstall(index: Map<string, TsPackage>, target: { fullName: string; version?: string }, installed: Map<string, string>): { plan: PlannedPackage[]; skipped: string[]; missing: string[] }`
  - `findUpdates(mods: InstalledMod[], index: Map<string, TsPackage>): ModUpdate[]`
  - `installedVersions(mods: InstalledMod[], loaderPackageIds: string[]): Map<string, string>`

Rules for `resolveInstall`:
- Target version defaults to the newest version; an unknown target `fullName` or version throws `Error("<fullName> isn't on Thunderstore for this game.")` / `Error("<fullName> <version> isn't available.")`.
- Each dependency asks for its listed version as a **minimum**. If the same package is required at several versions, the highest wins. If the dependency's required version isn't in the index, use the newest available version that is ≥ required; if none, it goes in `missing` (as the raw dependency string).
- A package already installed at ≥ the required version is not planned and goes in `skipped`. Installed at a lower version → planned at the required version (upgrade). The target itself is skipped only if installed at exactly the requested version.
- Dependencies of a skipped package are not walked.
- `plan` is dependency-first (a package appears after all its planned dependencies), each package once. Cycles terminate (visited set); order within a cycle is unspecified but each appears once.
- `installedVersions` maps each Thunderstore mod's `source.fullName` → `version`. Loader alias: for each id in `loaderPackageIds` (e.g. `BepInEx-BepInExPack`), if an installed mod of any source has `id` equal to that id **or** to its part after the first `-` (`BepInExPack`, the id a local zip install gets), map the loader id → that mod's version.

Rules for `findUpdates`: Thunderstore-source mods whose package is in the index and whose newest version is greater than the installed version. Mods not in the index are ignored.

- [ ] **Step 1: Failing tests**: `parseDependency` (`BepInEx-BepInExPack-5.4.2100`, an owner with a dash `Some-Team-Mod-1.0.0` → fullName `Some-Team-Mod`, invalid strings → null); `compareVersions` (`1.10.0 > 1.9.0`, `1.0 == 1.0.0`); chain A→B→C ordered C,B,A; diamond (A→B,C; B→D-1.0.0; C→D-2.0.0) plans D once at 2.0.0 before B and C; cycle A→B→A terminates; missing dependency reported and others planned; installed newer dependency skipped; installed older dependency upgraded; target already at requested version → empty plan, target in `skipped`; explicit older target version honoured; unknown target throws the exact message; `installedVersions` loader alias for a local `BepInExPack` install satisfies `BepInEx-BepInExPack-5.4.2100`; `findUpdates` returns only newer, ignores local/github mods and unknown packages.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** (pure functions, no I/O).
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5: Commit** `feat(thunderstore): dependency resolution and update detection`

---

### Task 4: Download and install service

**Files:**
- Create: `src/main/thunderstore/download.ts`
- Modify: `src/main/services.ts`
- Test: `tests/main/thunderstore/download.test.ts`, `tests/main/services.test.ts` (new `describe('thunderstore')`)

**Interfaces:**
- Consumes: Tasks 1–3, `installZip`, the services per-profile serializer, `requireGame`, catalog `modloaderPackages`.
- Produces:
  - `downloadPackage(opts: { url: string; fullName: string; version: string; downloadsDir: string; fetch: typeof fetch }): Promise<Uint8Array>` — returns the cached file `<downloadsDir>/<fullName>-<version>.zip` if present and starts with `PK\x03\x04`; otherwise fetches, requires `res.ok` and a body starting with `PK\x03\x04`, writes via temp file + rename, returns bytes. Failure throws `Error("Download of <fullName> <version> failed: <reason>")` and leaves no file. A cached file that fails the magic check is deleted and re-downloaded.
  - Services (exposed later in Task 5), all taking `game` label first:
    - `tsSearch(game: string, q: TsQuery): Promise<TsSearchResult>`
    - `tsRefresh(game: string): Promise<{ count: number; fetchedAt: string; stale: boolean }>`
    - `tsGetPackage(game: string, fullName: string): Promise<TsPackage | null>`
    - `tsInstall(game: string, profileId: string, fullName: string, version?: string): Promise<TsInstallResult>`
    - `tsCheckUpdates(game: string, profileId: string): Promise<ModUpdate[]>`
    - `tsUpdate(game: string, profileId: string, modIds: string[]): Promise<TsInstallResult>`
  - `ServiceDeps` gains `emit(e: HmlEvent): void`.

Rules:
- Index per game is held in memory (keep the 2 most recently used games); the first call loads via `loadPackageIndex` (cache → network). `tsRefresh` passes `force: true`. A game with `packageIndex === null` → `Error("<displayName> has no Thunderstore listing.")`.
- `tsInstall` requires `game.supported`, else `Error("<displayName> uses a mod loader HML doesn't support yet.")`. It runs inside the per-profile serializer: resolve with `installedVersions(profile.mods, loader ids for game.loader)`, then for each planned package in order: `emit({ type: 'progress', message: 'Installing <name> <version>', done: i, total })`, download, `installZip(paths, def, catalog, profileId, data, { kind: 'thunderstore', fullName }, { packageId: fullName, name, version })`. Finish with a `done: total` event. On failure, rethrow `Error("<fullName>: <message>")`; earlier installs stay.
- `tsUpdate` resolves each requested Thunderstore mod at its newest version (merging plans, skipping duplicates) and installs like `tsInstall`. Non-Thunderstore ids are ignored.

- [ ] **Step 1: Failing tests** — download: caches and reuses (second call no fetch); 404 → error message names package+version, no file; HTML body with 200 → error, no file; corrupt cached file re-downloaded. Services (fake fetch serving gzipped index/chunks and small real zips built with `fflate.zipSync` containing a `manifest.json` and a `.dll`): install with one dependency installs both, dependency first, both recorded with `source.kind === 'thunderstore'` and id `Owner-Name`; progress events emitted with increasing `done` and final `done === total`; second dependency download 404 → error starts with that package's `fullName`, first package remains installed and the profile lists it; unsupported game rejects with the exact message; `packageIndex: null` rejects with the exact message; `tsCheckUpdates` after the index gains a newer version lists it; `tsUpdate` installs it and the profile shows the new version; `tsSearch` returns ≤ `limit` items and `stale: false`, then with fetch failing and `tsRefresh` → `stale: true` with cached items.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** run the two files → PASS; full suite `npx vitest run --maxWorkers=2`; typecheck.
- [ ] **Step 5: Commit** `feat(thunderstore): download, install with dependencies, updates`

---

### Task 5: IPC, events and external links

**Files:**
- Modify: `src/shared/ipc.ts`, `src/main/ipc.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/env.d.ts`, `src/main/services.ts`
- Test: `tests/shared/ipc.test.ts`, `tests/main/services.test.ts`

**Interfaces:**
- Produces on `HmlApi` (and `METHOD_TABLE`): the six `ts*` methods from Task 4 with identical signatures, plus `openExternal(url: string): Promise<void>`.
- `openExternal` accepts only `https:` URLs whose host is `thunderstore.io`, a subdomain of it, `github.com`, or `www.github.com`; anything else throws `Error("HML only opens Thunderstore and GitHub links.")`. Implemented via a `ShellPort.openExternal(url)` added next to `openPath`.
- Events: main sends `webContents.send('hml:event', e)` for every `emit`. Preload exposes `window.hmlEvents.on(cb: (e: HmlEvent) => void): () => void` (returns an unsubscribe). Typed in `env.d.ts`.

- [ ] **Step 1: Failing tests**: `HML_METHODS` contains the seven new names; `openExternal` accepts `https://thunderstore.io/c/repo/p/a/b/` and `https://github.com/x/y`, rejects `http://thunderstore.io/`, `https://evil.com/`, `https://thunderstore.io.evil.com/`, `file:///etc/passwd` with the exact message.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** (index.ts wires `emit` to the main window's `webContents` if it exists and isn't destroyed).
- [ ] **Step 4:** tests PASS; `npm run typecheck && npm run build`.
- [ ] **Step 5: Commit** `feat(thunderstore): ipc methods, progress events, external links`

---

### Task 6: Browse UI, package detail, updates

**Files:**
- Create: `src/renderer/src/components/Browse.tsx`, `src/renderer/src/components/PackageDetail.tsx`
- Modify: `src/renderer/src/components/ModList.tsx`, `src/renderer/src/store.ts`, `src/renderer/src/App.tsx` (event subscription if needed)

**Interfaces:**
- Consumes: Task 5 API and `window.hmlEvents`.

Requirements:
- ModList gets a second tab **Online** next to **Installed**.
- Online tab: debounced (250 ms) search box; sort select (Top rated / Most downloaded / Recently updated / Name); category chips from `TsSearchResult.categories` (multi-select, AND); toggles "Show deprecated" and "Show NSFW" (both off by default); results list of 50 with a "Load more" button that appends the next page; a Refresh button calling `tsRefresh`. Stale results show an inline notice "Thunderstore is unreachable — showing the cached list from <relative time>". A failed first load shows the error message and a Retry button. Stale responses from earlier queries are ignored (sequence number).
- Result row: icon (fallback initials on load error), name, owner, short description (2 lines), downloads (compact, e.g. `1.2M`), rating; right side shows **Installed** (with installed version) when the profile has a mod with id `fullName`, **Update** when installed older than newest, else **Install**. Deprecated packages show a "Deprecated" badge. Clicking the row opens PackageDetail.
- PackageDetail (side panel or dialog): icon, name, owner, categories, full description, version select (newest default), dependency list of the selected version, "Open on Thunderstore" (`openExternal(packageUrl)`), website link when present (`openExternal` — if rejected, show the URL as copyable text instead), Install button for the selected version.
- Installing: buttons disabled for that package while running; a progress line from `progress` events ("Installing BepInExPack 5.4.2100 (1/3)"); on success a toast "Installed <name>" plus " — missing dependencies: …" when `missing` is non-empty (kind `info`); profile mods reload.
- Installed tab: when the profile loads or after an install/refresh, call `tsCheckUpdates`; Thunderstore mods with an update show an "Update to <latest>" button; an "Update all (<n>)" button appears above the list when n > 0.
- Fix the plan-1 parked store minor while touching it: replace the boolean `busy` with a counter (`busyCount`, `busy = busyCount > 0`) so overlapping operations don't clear each other's busy state.
- Unsupported-loader games: the Online tab still searches, but Install buttons are disabled with tooltip "Mod loader not supported yet".

- [ ] **Step 1:** Use the frontend-design skill; match the existing plan-1 look (dark, orange accent, `components/ui.tsx` primitives).
- [ ] **Step 2: Implement.**
- [ ] **Step 3:** `npm run typecheck && npm run lint && npm run build` pass; `npx vitest run --maxWorkers=2` passes.
- [ ] **Step 4: Visual check:** `npx electron-vite dev -- --user-data-dir=/tmp/hml-ts-dev` with settings seeded `{"gamePathOverrides":{},"steamRootOverride":null,"lastGame":"repo","lastProfile":{}}`; confirm the Online tab lists R.E.P.O. packages with icons. Note in the report what could not be clicked through.
- [ ] **Step 5: Commit** `feat(ui): thunderstore browse, package detail, updates`
