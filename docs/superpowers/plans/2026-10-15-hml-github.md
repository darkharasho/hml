# HML GitHub Installs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paste a GitHub repo or release URL, install the release's mod file into the active profile, and keep it updated automatically.

**Architecture:** A main-process GitHub client fetches releases (`/releases/latest`, falling back to `/releases`) with ETag conditional requests cached on disk, picks an asset with a fixed preference order (asking the user when it can't decide), downloads it, and feeds it to the existing `installZip` with package id `<owner>-<repo>`. Per-mod update settings live on the installed mod record. A background check runs on startup and every 6 hours and installs updates for mods set to auto.

**Tech Stack:** Electron main (`fetch`, `safeStorage`), `fflate`, existing `installZip`/profiles/services, React + zustand + Tailwind renderer.

**Spec:** `docs/superpowers/specs/2026-10-15-hml-design.md` (sections "GitHub (plan 3)", "Mod identity", "Defaults chosen").

## Global Constraints

- Vitest always runs with `--maxWorkers=2`.
- The renderer never imports Node modules. Every privileged action goes through `HmlApi` (`src/shared/ipc.ts`); new methods go in `METHOD_TABLE`.
- Every JSON write uses `writeJsonAtomic` (`src/main/store/json.ts`).
- Data root is injected (`AppPaths`); tests use a temp dir and an injected `fetch`. No test touches the network.
- GitHub mods are recorded with `source: { kind: 'github', owner, repo, tag, asset, sha256 }` and installed with `installZip(..., { packageId: '<owner>-<repo>', name, version })`, so the mod id is `<owner>-<repo>`.
- GitHub mods auto-install updates by default (spec "Defaults chosen").
- Update checks run on startup and every 6 hours using ETag conditional requests.
- The GitHub token is stored only with `safeStorage`, is sent only to `https://api.github.com/`, and never crosses IPC to the renderer.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Platforms: Windows + Linux.

### Facts verified against the live API (2026-10-15)

- `GET https://api.github.com/repos/<o>/<r>/releases/latest` returns the newest non-draft, non-prerelease release; 404 when the repo has none (or doesn't exist). `GET …/releases?per_page=10` lists newest first, including prereleases. `GET …/releases/tags/<tag>` fetches one release.
- Release fields used: `tag_name`, `name`, `prerelease`, `draft`, `published_at`, `html_url`, `assets[]`. Asset fields: `id`, `name`, `size`, `browser_download_url` (`https://github.com/<o>/<r>/releases/download/<tag>/<name>`), `url` (`https://api.github.com/repos/<o>/<r>/releases/assets/<id>`), `digest` (`"sha256:<hex>"`, may be absent on old assets). Source-code archives are not in `assets` (they are `zipball_url`/`tarball_url`).
- Responses carry a weak `ETag`; a request with `If-None-Match` returns `304` with no body. Unauthenticated requests are limited to 60/hour and 304s still count, so lookups are also memoized for 10 minutes. Rate-limited responses are `403` or `429` with `x-ratelimit-remaining: 0` and `x-ratelimit-reset` (epoch seconds).
- `browser_download_url` 302-redirects to `release-assets.githubusercontent.com`. `fetch` follows it; Node's `fetch` drops `Authorization` on cross-origin redirects, so downloading via the API `url` with `Accept: application/octet-stream` and a token is safe.
- GitHub requires a `User-Agent` header; send `User-Agent: HML`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`.

## Decisions this plan makes (the spec leaves them open)

- A `/releases/tag/<tag>` or `/releases/download/<tag>/<file>` URL installs that exact release (and file) and sets the mod to **pinned**; a plain repo URL installs the latest release with mode **auto**. Reinstalling a repo keeps its existing mode.
- "Newer": when both tags are version-like (`/^v?\d+(\.\d+)*$/i`), the latest tag is newer only if `compareVersions` (leading `v` stripped) says so; otherwise any different tag counts as an update.
- Displayed version: the zip's `manifest.json` `version_number` when present, else the tag with a leading `v`/`V` stripped. Update detection always uses the tag.
- A lone `.dll` asset is wrapped into a zip in memory (`{ [asset.name]: bytes }`) so the planner routes it like any plugin.
- No disk cache for GitHub downloads (downloads are in memory only).
- A local mod whose id equals the zip's manifest name is replaced by the GitHub install (same rule plan 2 uses for Thunderstore). An already-installed GitHub mod whose owner/repo matches case-insensitively but whose id differs is also replaced, so one repo is never installed twice.
- Background update failures are logged with `console.warn` and retried next cycle; the mod keeps showing its update in the UI, where a manual update surfaces the error.
- Private repositories work when a token is set (API lookups and the token-authenticated asset download).

## Review Focus

1. GitHub unreachable, rate limited, or the token rejected during a background check: nothing installs partially, other repos are still checked, the installed version stays; a manual action shows a readable message that mentions adding a token where relevant. (Task 2 error-message tests, Task 3 auto-update test where one repo fails and the next still updates)
2. Repos with no releases, only prereleases, no installable asset, or that don't exist: each gives a distinct readable message, nothing is written. (Task 2 and Task 3 tests)
3. A release with several zips (per-platform variants), none with a manifest: the user is asked; the saved pattern picks the same variant on the next release even though the version in the file name changed. (Task 1 pattern tests, Task 3 update-with-pattern test)
4. A download that fails or doesn't match the asset's sha256 digest during an update: the old version stays installed and recorded. (Task 3 test)
5. The token never reaches the renderer and is never sent to a host other than `api.github.com`. (Task 2 header tests, Task 4 `ghTokenStatus` test)

---

## File Structure

- `src/shared/types.ts`: GitHub types below; `InstalledMod.github?`; `HmlEvent` gains `github-updated`.
- `src/main/store/paths.ts`: add `ghCache` and `ghToken`.
- `src/main/github/url.ts`: parse pasted URLs (Task 1).
- `src/main/github/assets.ts`: asset patterns and asset choice (Task 1).
- `src/main/github/api.ts`: release lookup with ETag cache, asset download, errors (Task 2).
- `src/main/github/token.ts`: encrypted token storage through a `SecretPort` (Task 2).
- `src/main/github/service.ts`: install, update, update checks, update modes, background auto-update (Task 3).
- `src/main/services.ts`, `src/shared/ipc.ts`, `src/main/index.ts`: wiring, token methods, scheduler (Tasks 3–4).
- `src/renderer/src/store.ts`, `src/renderer/src/components/ModList.tsx`, new `src/renderer/src/components/GithubDialog.tsx`, `src/renderer/src/components/SettingsDialog.tsx`, new `src/renderer/src/ghView.ts`: UI (Task 5).
- Tests mirror under `tests/main/github/`, `tests/main/services.test.ts`, `tests/renderer/ghView.test.ts`.

## Shared types (added in Task 1, used by all later tasks)

```ts
export type GhUpdateMode = 'auto' | 'notify' | 'pinned'
export interface GhModConfig {
  updateMode: GhUpdateMode
  /** Saved when the user picked the asset; `{version}` stands for version-like parts. */
  assetPattern: string | null
}
// InstalledMod gains:  github?: GhModConfig   (set only on github-source mods)
export interface GhAsset { name: string; size: number }
export type GhInstallResult =
  | { kind: 'installed'; mod: InstalledMod; replaced: string[] }
  | { kind: 'choose-asset'; owner: string; repo: string; tag: string; assets: GhAsset[] }
export interface GhUpdate {
  modId: string
  owner: string
  repo: string
  current: string // installed tag
  latest: string  // latest tag
  mode: GhUpdateMode
}
// HmlEvent becomes:
//   | { type: 'progress'; message: string; done: number; total: number }
//   | { type: 'github-updated'; game: string; profileId: string; mods: { name: string; tag: string }[] }
```

---

### Task 1: URL parsing and asset choice

**Files:**
- Modify: `src/shared/types.ts` (types above)
- Create: `src/main/github/url.ts`, `src/main/github/assets.ts`
- Test: `tests/main/github/url.test.ts`, `tests/main/github/assets.test.ts`

**Interfaces:**
- Consumes: `detectPackageMeta`, `readZipEntries` (`src/main/install/installer.ts`).
- Produces:
  - `interface GhRef { owner: string; repo: string; tag?: string; asset?: string }`
  - `parseGithubUrl(input: string): GhRef | null`
  - `interface GhReleaseAsset { id: number; name: string; size: number; downloadUrl: string; apiUrl: string; digest: string | null }` (exported from `assets.ts`; Task 2 builds these)
  - `assetPattern(name: string, tag: string): string`
  - `matchesAssetPattern(pattern: string, name: string): boolean`
  - `chooseAsset(assets: GhReleaseAsset[], pattern: string | null, download: (a: GhReleaseAsset) => Promise<Uint8Array>): Promise<{ asset: GhReleaseAsset; data: Uint8Array } | { ask: GhReleaseAsset[] }>`

Rules for `parseGithubUrl`:
- Trim. Accept with or without scheme (`https://`, `http://`), host `github.com` or `www.github.com`, and the bare shorthand `owner/repo`. Ignore query and hash. Strip a trailing `.git` and trailing slashes.
- `owner` matches `/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/`; `repo` matches `/^[A-Za-z0-9._-]{1,100}$/` and is not `.` or `..`. Anything else → `null`.
- Path after `owner/repo`: `/releases/tag/<tag>` → `tag`; `/releases/download/<tag>/<asset>` → `tag` and `asset` (both URL-decoded); anything else (`/releases`, `/releases/latest`, `/tree/main`, `/issues`) → just owner and repo.
- Any other host, or fewer than two path segments → `null`.

Rules for `assetPattern`: replace (case-insensitively) the full tag and then the tag without a leading `v` (each only when at least 2 characters long) with `{version}`, then every remaining match of `/(?<![A-Za-z0-9])v?\d+(?:\.\d+)+(?![A-Za-z0-9])/gi` with `{version}`. `matchesAssetPattern` is a full, case-insensitive match where `{version}` matches one or more characters and everything else is literal.

Rules for `chooseAsset`:
1. Candidates: drop assets whose name ends in `.tar.gz`, `.tgz`, or contains a `source`/`src` token (`/(^|[-_. ])(source|src)([-_. ]|$)/i`).
2. If `pattern` is set and exactly one candidate matches it, that's the asset. Otherwise continue.
3. `.zip` candidates (case-insensitive): exactly one → it. More than one → download the first 5 of them that are ≤ 100 MB (`size ≤ 104_857_600`), in listed order; if exactly one has a manifest (`detectPackageMeta(readZipEntries(data), '') !== null`), it's the asset (reuse its downloaded bytes); otherwise ask.
4. No `.zip`: exactly one `.dll` candidate → it. Otherwise ask.
5. Ask returns every `.zip` and `.dll` candidate. If that list is empty, throw `Error("This release has no .zip or .dll file to install.")`.
- The returned `data` is the asset's bytes: reuse a probe download, else call `download` once.

- [ ] **Step 1: Write failing tests**
  - url: `https://github.com/BepInEx/BepInEx` → `{ owner: 'BepInEx', repo: 'BepInEx' }`; `github.com/a/b.git/` → repo `b`; `www.github.com/a/b?tab=readme#x` → ok; `a/b` → ok; `https://github.com/a/b/releases/tag/v1.2%2Bx` → tag `v1.2+x`; `https://github.com/a/b/releases/download/v1/Mod.zip` → tag `v1`, asset `Mod.zip`; `https://github.com/a/b/releases/latest` → no tag; `https://gitlab.com/a/b`, `https://github.com/a`, `https://github.com/-bad/x`, `https://github.com/a/..`, `''`, `not a url` → `null`.
  - pattern: `assetPattern('BepInEx_linux_x64_5.4.23.5.zip', 'v5.4.23.5')` → `'BepInEx_linux_x64_{version}.zip'`; it matches `BepInEx_linux_x64_5.4.24.0.zip` and not `BepInEx_linux_x86_5.4.24.0.zip`; `assetPattern('MyMod-v1.2.zip', 'v1.2')` → `'MyMod-{version}.zip'`; `assetPattern('mod-r42.zip', 'r42')` → `'mod-{version}.zip'`; `assetPattern('Plugin.zip', 'v3')` → `'Plugin.zip'`; matching ignores case.
  - choose: one zip + one dll → the zip, `download` called once; two zips where only the second has `manifest.json` → the second, using its probe bytes (download called twice in total); two zips without manifests → `ask` with both; no zip, one dll → the dll; two dlls → `ask`; only `Mod-src.zip` and `Mod.tar.gz` → throws the exact message; a pattern matching exactly one of two zips → that one without probing; a pattern matching none → falls back to the rules above.
- [ ] **Step 2:** `npx vitest run tests/main/github --maxWorkers=2` → FAIL (modules missing).
- [ ] **Step 3: Implement** both modules (pure apart from the injected `download`).
- [ ] **Step 4:** tests PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(github): url parsing and asset choice`

---

### Task 2: GitHub API client and token storage

**Files:**
- Modify: `src/main/store/paths.ts`
- Create: `src/main/github/api.ts`, `src/main/github/token.ts`
- Test: `tests/main/github/api.test.ts`, `tests/main/github/token.test.ts`

**Interfaces:**
- Consumes: `GhReleaseAsset` (Task 1), `readJson`/`writeJsonAtomic`, `AppPaths`.
- Produces:
  - `paths.ghCache` → `<root>/cache/github.json`; `paths.ghToken` → `<root>/secrets/github-token.bin`
  - `interface GhRelease { tag: string; name: string; prerelease: boolean; publishedAt: string; htmlUrl: string; assets: GhReleaseAsset[] }`
  - `interface GhClientOpts { fetch: typeof fetch; token: string | null; cacheFile: string; now?: () => number }`
  - `fetchRelease(opts: GhClientOpts & { owner: string; repo: string; tag?: string; maxAgeMs?: number }): Promise<GhRelease>`
  - `downloadAsset(opts: { fetch: typeof fetch; token: string | null; asset: GhReleaseAsset }): Promise<{ data: Uint8Array; sha256: string }>`
  - `fetchLogin(opts: { fetch: typeof fetch; token: string }): Promise<string>`
  - `isNewerTag(latest: string, current: string): boolean` (rule in "Decisions")
  - `GH_RELEASE_MEMO_MS = 600_000`
  - `interface SecretPort { isAvailable(): boolean; encrypt(plain: string): Buffer; decrypt(data: Buffer): string }`
  - `loadToken(paths: AppPaths, secrets: SecretPort): Promise<string | null>`
  - `saveToken(paths: AppPaths, secrets: SecretPort, token: string | null): Promise<void>`

Rules for `fetchRelease`:
- With `tag`: `GET /repos/<o>/<r>/releases/tags/<encodeURIComponent(tag)>`. Without: `GET …/releases/latest`; on 404, `GET …/releases?per_page=10` and take the first entry with `draft !== true`.
- Headers on every API request: `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent: HML`, plus `Authorization: Bearer <token>` when a token is set.
- Cache file maps request URL → `{ etag: string; body: unknown; fetchedAt: number }` (written atomically; a corrupt file counts as empty). When `maxAgeMs` is given and the entry is younger, return it with no request. Otherwise send `If-None-Match: <etag>` when cached; `304` → use the cached body and refresh `fetchedAt`. A `200` replaces the entry.
- Normalize assets from `{ id, name, size, browser_download_url, url, digest }`; skip assets whose `browser_download_url` isn't `https://github.com/…` or whose `url` isn't `https://api.github.com/…`.
- Error messages (exact):
  - network failure: `Couldn't reach GitHub. Check your connection and try again.`
  - 403/429 with `x-ratelimit-remaining: 0`: `GitHub's rate limit was reached. Try again after <time>, or add a GitHub token in Settings.` where `<time>` is `new Date(reset * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })` (tests assert the prefix up to "after").
  - 401: `GitHub rejected the saved token. Update or remove it in Settings.`
  - tag 404: `<o>/<r> has no release <tag>.`
  - latest 404 and list 404: `Couldn't find github.com/<o>/<r>. Check the URL; private repositories need a GitHub token in Settings.`
  - list empty (or all drafts): `<o>/<r> has no releases yet.`
  - other non-OK: `GitHub returned HTTP <status> for <o>/<r>.`

Rules for `downloadAsset`: with a token, `GET asset.apiUrl` with `Accept: application/octet-stream`, `User-Agent: HML` and `Authorization`; without one, `GET asset.downloadUrl` with only `User-Agent: HML`. Non-OK → `Download of <name> failed: HTTP <status>`; network error → `Download of <name> failed: <message>`. `sha256` is the hex digest of the bytes; if `asset.digest` is `sha256:<hex>` and differs → `Download of <name> failed: checksum mismatch`.

Rules for token storage: `saveToken(null)` deletes the file. `saveToken` with `!secrets.isAvailable()` throws `Error("Secure storage isn't available on this system, so HML can't save a GitHub token.")`. `loadToken` returns null when the file is missing, storage is unavailable, or decryption throws.

`fetchLogin`: `GET https://api.github.com/user` with the API headers; 401 → `Error("GitHub didn't accept that token.")`; other failures use the `fetchRelease` messages; returns `login`.

- [ ] **Step 1: Write failing tests** (fake `fetch` records URL and headers per call and answers from a route table)
  - latest found: one request to `…/releases/latest` with the four headers and no `Authorization` when token is null; result normalized (assets mapped, digest kept).
  - with a token: `Authorization: Bearer t0k` present.
  - second call returns 304 → `If-None-Match` sent, same release returned; cache file holds the entry.
  - `maxAgeMs: 600_000` within the window → no request; past it → conditional request.
  - latest 404 → list fallback returns the newest non-draft (a prerelease); list `[]` → `<o>/<r> has no releases yet.`; both 404 → the "Couldn't find" message; tag 404 → `<o>/<r> has no release v9.`
  - rate limit (403, `x-ratelimit-remaining: 0`, `x-ratelimit-reset`) → message starts with `GitHub's rate limit was reached. Try again after`; 401 → the token message; fetch throws → the connection message.
  - an asset with a non-github `browser_download_url` is dropped.
  - corrupt cache file → treated as empty.
  - download without token: requests `downloadUrl`, headers contain no `Authorization`; with token: requests `apiUrl` with `Accept: application/octet-stream` and `Authorization`; digest mismatch → checksum message; 404 → `Download of Mod.zip failed: HTTP 404`; returned `sha256` equals `createHash('sha256')` of the body.
  - `isNewerTag`: `('v1.10.0','v1.9.0')` true, `('1.0','v1.0.0')` false, `('v1.0','v2.0')` false, `('nightly-b','nightly-a')` true, `('same','same')` false.
  - token: save then load round-trips through a fake `SecretPort` (reverses the string); file content is not the plain token; `saveToken(null)` removes it; unavailable storage → save throws the exact message, load returns null; decrypt throwing → null.
  - `fetchLogin` returns `login`; 401 → exact message.
- [ ] **Step 2:** `npx vitest run tests/main/github --maxWorkers=2` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** tests PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(github): release client with etag cache, asset download, token storage`

---

### Task 3: GitHub install, update and auto-update service

**Files:**
- Create: `src/main/github/service.ts`
- Modify: `src/main/services.ts`, `src/shared/ipc.ts`, `tests/shared/ipc.test.ts`
- Test: `tests/main/services.test.ts` (new `describe('github')`)

**Interfaces:**
- Consumes: Tasks 1–2; `installZip`, `readZipEntries`, `detectPackageMeta`, `getProfile`, `saveProfile`, `listProfiles`; from `services.ts`: `getCatalog`, `requireGame`, `serialize`, and the existing unsupported-loader message.
- Produces:
  - `ServiceDeps` gains `secrets: SecretPort`.
  - On `HmlApi` and `METHOD_TABLE`:
    - `ghInstall(game: string, profileId: string, url: string, asset?: string): Promise<GhInstallResult>`
    - `ghCheckUpdates(game: string, profileId: string): Promise<GhUpdate[]>`
    - `ghUpdate(game: string, profileId: string, modIds: string[]): Promise<InstalledMod[]>`
    - `ghSetUpdateMode(game: string, profileId: string, modId: string, mode: GhUpdateMode): Promise<void>`
  - `createServices(deps)` returns `HmlApi & { ghAutoUpdateAll(): Promise<void> }` (not an IPC method).
  - `GH_CHECK_INTERVAL_MS = 21_600_000` exported from `service.ts`.
  - `createGithubServices(ctx: GhContext)` in `service.ts`, where `GhContext = { deps: ServiceDeps; getCatalog(): Promise<Catalog>; requireGame(label: string): Promise<GameDef>; serialize<T>(game: string, profileId: string, fn: () => Promise<T>): Promise<T> }`. `services.ts` builds the context and spreads the result.

Rules:
- `ghInstall`: unparseable URL → `Error("That isn't a GitHub repository link. Paste one like https://github.com/owner/repo.")`. Unsupported game → the same message `tsInstall` uses. Emits `progress` events (`Checking <owner>/<repo>`, `Downloading <asset>`, `Installing <name> <version>`, then `Done`, with `total: 3`). Fetches the release fresh (no `maxAgeMs`) for `ref.tag`. Asset: `asset` argument, else `ref.asset`, by exact name (missing → `Error("<tag> has no file named <asset>.")`); else the existing mod's `assetPattern` with `chooseAsset`; `ask` → return `choose-asset` with `{ name, size }` of each asked asset and install nothing. Installs inside `serialize` with the rules in "Decisions" (packageId `<owner>-<repo>`, `replaces` for a same-name local mod and a case-insensitive same-repo GitHub mod). Then sets `github` on the record: `updateMode` = `'pinned'` if `ref.tag`, else the previous record's mode, else `'auto'`; `assetPattern` = `assetPattern(chosen.name, tag)` when the name came from the `asset` argument or `ref.asset`, else the previous pattern, else `null`.
- `ghCheckUpdates`: for each GitHub mod not pinned, `fetchRelease` with `maxAgeMs: GH_RELEASE_MEMO_MS` (one lookup per owner/repo, case-insensitive), list it when `isNewerTag(latest, source.tag)`. A failing lookup skips that mod.
- `ghUpdate`: for each requested GitHub mod that isn't pinned and has a newer release, choose the asset with its saved pattern; `ask` → `Error("<owner>/<repo> <tag> has several files and none matches the one you picked before. Reinstall it from its GitHub link to choose again.")`. Download before touching the profile. Install in `serialize`, keep `github` config. The first failure throws `Error("<owner>/<repo>: <message>")`; earlier updates stay.
- `ghSetUpdateMode`: validates `mode` and that the mod is a GitHub mod (`Error("<modId> isn't a GitHub mod.")`), writes only that record's `github.updateMode`, inside `serialize`.
- `ghAutoUpdateAll`: one run at a time (a second call while running returns the same promise). For each directory in `paths.gamesDir` that is a catalog game with `supported`, each profile, each GitHub mod with mode `auto` and a newer release (fresh lookups, one per owner/repo per run): update it like `ghUpdate`. Per-mod failures are `console.warn`ed and the run continues. After each profile with at least one update, emit `{ type: 'github-updated', game, profileId, mods: [{ name, tag }] }`.

- [ ] **Step 1: Write failing tests** (fake fetch serves the catalog fixture, `api.github.com` release JSON and `github.com` download URLs returning small `fflate.zipSync` zips with `manifest.json` + a `.dll`; `secrets` is a fake `SecretPort`)
  - repo URL install: mod id `owner-repo`, `source` has owner, repo, tag, asset and the sha256 of the bytes, `github.updateMode === 'auto'`, files under `BepInEx/plugins/owner-repo/`; progress events end with `done === total`.
  - tag URL install → `updateMode: 'pinned'`, the tag's release used.
  - lone dll release installs the dll into the plugins folder.
  - two manifest-less zips → `{ kind: 'choose-asset', assets: [two names with sizes] }` and the profile is unchanged; calling again with `asset` installs that one and stores `assetPattern`.
  - installing `https://github.com/Owner/Repo` after `https://github.com/owner/repo` leaves one mod; reinstall keeps `updateMode: 'notify'` set earlier with `ghSetUpdateMode`.
  - a local mod with the manifest's name is replaced and reported in `replaced`.
  - `ghCheckUpdates` lists a newer tag, ignores pinned mods, and makes no second request within 10 minutes.
  - `ghUpdate` installs the new tag and keeps config; with a saved pattern it picks the matching per-platform zip of the next release; a checksum mismatch throws `owner/repo: Download of … failed: checksum mismatch` and the old version stays recorded with its files present.
  - unsupported game and bad URL reject with the exact messages; `ghSetUpdateMode` on a Thunderstore mod rejects with the exact message.
  - `ghAutoUpdateAll`: two profiles across one game, repo A (auto) fails with HTTP 500 and repo B (auto) succeeds → B updated, A unchanged, one `github-updated` event for B's profile; a `notify` mod is not updated; concurrent calls share one run (fetch counts don't double).
  - `HML_METHODS` contains the four new names.
- [ ] **Step 2:** `npx vitest run tests/main/services.test.ts tests/shared/ipc.test.ts --maxWorkers=2` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** tests PASS; full suite `npx vitest run --maxWorkers=2`; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(github): install, update checks and auto-update`

---

### Task 4: Token methods, safeStorage and the update scheduler

**Files:**
- Modify: `src/shared/ipc.ts`, `src/main/services.ts` (or `src/main/github/service.ts`), `src/main/index.ts`
- Test: `tests/main/services.test.ts`, `tests/shared/ipc.test.ts`

**Interfaces:**
- Consumes: Task 2 token storage and `fetchLogin`; Task 3 `ghAutoUpdateAll`, `GH_CHECK_INTERVAL_MS`.
- Produces on `HmlApi` and `METHOD_TABLE`:
  - `ghSetToken(token: string | null): Promise<{ login: string | null }>`
  - `ghTokenStatus(): Promise<{ set: boolean; encryptionAvailable: boolean }>`

Rules:
- `ghSetToken`: trims; `null` or empty removes the token and returns `{ login: null }`. A token with whitespace inside, control characters, or longer than 255 characters → `Error("That doesn't look like a GitHub token.")`. Otherwise `fetchLogin` first (failure throws, nothing saved), then `saveToken`, returning `{ login }`. Every later GitHub request in services uses the saved token (`loadToken` per operation, no in-memory copy that could go stale).
- `ghTokenStatus` never includes the token.
- `index.ts`: `secrets` is backed by Electron `safeStorage`: `isAvailable()` is `safeStorage.isEncryptionAvailable()` and, on Linux, also `safeStorage.getSelectedStorageBackend() !== 'basic_text'`. After `createWindow()`, run `ghAutoUpdateAll()` once after 10 seconds and then every `GH_CHECK_INTERVAL_MS`; errors are caught and logged.

- [ ] **Step 1: Write failing tests**: set token calls `https://api.github.com/user` with `Authorization: Bearer <token>` and returns `{ login }`; status then `{ set: true, encryptionAvailable: true }` and the JSON of the status object doesn't contain the token; after saving, a `ghInstall` sends `Authorization` only on requests whose URL starts with `https://api.github.com/` (the release lookup and the `apiUrl` asset download) and never requests `browser_download_url`; rejected token (401) → `GitHub didn't accept that token.` and status stays `set: false`; `'ab cd'` → the exact format message; `null` clears; unavailable storage → the storage message from Task 2. `HML_METHODS` contains both names.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** tests PASS; `npm run typecheck && npm run build`.
- [ ] **Step 5: Commit** `feat(github): token settings, secure storage, update scheduler`

---

### Task 5: GitHub UI

**Files:**
- Create: `src/renderer/src/components/GithubDialog.tsx`, `src/renderer/src/ghView.ts`
- Modify: `src/renderer/src/store.ts`, `src/renderer/src/components/ModList.tsx`, `src/renderer/src/components/SettingsDialog.tsx`, `src/renderer/src/components/ui.tsx` (only if `Menu` needs a checked item)
- Test: `tests/renderer/ghView.test.ts`

**Interfaces:**
- Consumes: Tasks 3–4 API and the `github-updated` event via `window.hmlEvents`.
- Produces in `ghView.ts`: `formatBytes(n: number): string` (`512 B`, `1.5 KB`, `12.3 MB`), `updateModeLabel(m: GhUpdateMode): string` (`Auto-install updates`, `Notify only`, `Pinned`), `githubRepoUrl(source: { owner: string; repo: string }): string` (`https://github.com/<owner>/<repo>`).

Requirements:
- Installed tab toolbar: an **Add from GitHub** button next to **Install from file** (disabled for unsupported-loader games with the `UNSUPPORTED_LOADER` tooltip).
- GithubDialog: URL field (autofocus, Enter submits), hint "Paste a repository or release link. HML installs the latest release and keeps it updated." Install shows the progress line while running. Errors show inline in the dialog. On `choose-asset`: list the assets as radio options with sizes, text "This release has several files. Pick the one to install. HML will pick the matching file for future updates.", and **Install selected** calls `ghInstall` again with the asset. Success closes the dialog and toasts `Installed <name> <version>` (plus ` (pinned to this release)` when the mod's mode is pinned, and `, replaced <ids>` when `replaced` is non-empty).
- GitHub mod rows: subline `<owner>/<repo> · <tag>` plus ` · Notify only` / ` · Pinned` when not auto; an **Update to <latest>** button when it has a `GhUpdate`; row menu adds **Open on GitHub**, the three update modes (current one marked), then **Uninstall…**.
- Updates: the store keeps `ghUpdates: GhUpdate[]`, loaded alongside `tsCheckUpdates` whenever Thunderstore updates are checked (and for games without a Thunderstore listing), with the same stale-response guard. **Update all (n)** counts both lists and runs both updates.
- `github-updated` event for the current game and profile: reload profiles, refresh updates, toast `Updated <name> to <tag>` (or `Updated <n> GitHub mods`); for another profile, only the toast.
- SettingsDialog gains a GitHub section: password field + **Save token** + **Remove**; status line `Signed in as <login>` after a save in this session, else `A token is saved.` or `No token saved. Without one, GitHub allows 60 update checks per hour.`; when `encryptionAvailable` is false the field is disabled with `Secure storage isn't available on this system, so HML can't save a GitHub token.` The token value is cleared from the field after saving.

- [ ] **Step 1:** Use the frontend-design skill; match the existing look (dark, orange accent, `components/ui.tsx` primitives).
- [ ] **Step 2:** Write `tests/renderer/ghView.test.ts` for the three helpers, then implement.
- [ ] **Step 3:** `npm run typecheck && npm run lint && npm run build` pass; `npx vitest run --maxWorkers=2` passes.
- [ ] **Step 4: Visual check:** `npx electron-vite dev -- --user-data-dir=/tmp/hml-gh-dev` with settings seeded `{"gamePathOverrides":{},"steamRootOverride":null,"lastGame":"repo","lastProfile":{}}`; install `https://github.com/BepInEx/BepInEx` and confirm the asset chooser appears (several per-platform zips); note in the report what could not be clicked through.
- [ ] **Step 5: Commit** `feat(ui): github installs, update modes, token settings`
