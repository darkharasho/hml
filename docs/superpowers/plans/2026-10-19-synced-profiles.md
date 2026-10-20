# Synced Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner shares a sync code once; every later change to that profile (mods, versions, enable/disable, configs) reaches every follower automatically, with follower config tweaks merged per setting.

**Architecture:** The existing `hml-share` Worker gains `/v1/sync` routes that store each code's latest `.hml` revision in one KV key, with the revision number and owner-key hash in KV metadata, and serve cheap "anything newer than N?" checks from the edge cache. In the app, a new `src/main/sync/` module publishes owner profiles (debounced, digest-compared), and polls and applies follower profiles (diff install via the share-import installers, plus a 3-way config merge against stored base copies). `services.ts` wires it in through a lock wrapper that refuses follower edits, plus hooks on its profile lock, update checks and launch.

**Tech Stack:** TypeScript, Electron main/renderer, React + zustand, Cloudflare Workers + KV, fflate, zod, vitest.

**Spec:** `docs/superpowers/specs/2026-10-19-synced-profiles-design.md`

## Global Constraints

- Cloudflare free tier: "anything newer?" checks must not read the revision body from KV, and should normally not touch KV at all. Owner publishes and stops are the only KV writes (one write each).
- Sync codes are 12 Crockford base32 characters, displayed `XXXX-XXXX-XXXX`. Share codes stay 10 characters, so older HML builds reject sync codes as invalid.
- Payload is the existing `.hml` format (`formatVersion: 1`) built by `src/main/share/hmlFile.ts`.
- Owner publish debounce: `SYNC_DEBOUNCE_MS = 10_000`. Follower poll and owner digest pass: `SYNC_POLL_MS = 300_000`. Retry while the game runs: `SYNC_HOLD_RETRY_MS = 30_000`. Pre-launch check timeout: `SYNC_LAUNCH_CHECK_MS = 10_000`.
- Expiry: the sync KV entry's TTL is `TTL_SECONDS` (1 year), refreshed on every publish. The ended tombstone keeps the same TTL.
- The owner key never leaves the owner's machine except as a bearer header to the Worker. The server stores only its SHA-256. With no OS secret storage, `createSyncCode` throws `noSecureStorage('sync codes')` before contacting the server.
- Toast copy names the profile, never a person: `"<Profile> updated: …"`, `"<Profile> is no longer synced"`.
- Follower-lock error copy: `This profile is synced from a friend. Detach it to change its mods.`
- Tests: `npx vitest run --maxWorkers=2 <path>` (never more than 2 workers). The full suite is `npm test`. Also run `npm run typecheck` and `npm run lint` before each commit.

## Review Focus

1. **Owner launches the game and it rewrites configs with identical values.** Expect no new revision and no follower toast. Pinned in Task 7 (`does not publish when only file timestamps change`).
2. **Follower is offline or the Worker is down when they hit Play.** Expect the launch to go ahead after at most `SYNC_LAUNCH_CHECK_MS`, with no error dialog. Pinned in Task 8 (`beforeLaunch gives up after the timeout`).
3. **The periodic tick fires while a follower check is already applying a revision (or two ticks overlap).** Expect one apply, not two interleaved ones. Pinned in Task 8 (`runs one check per profile at a time`).
4. **Follower config with CRLF line endings or a UTF-8 BOM.** Expect the merged file to keep both, and untouched lines to stay byte-identical. Pinned in Task 3.
5. **A revision where one download fails (GitHub rate limit, Thunderstore hiccup).** Expect the rest to apply, the profile marked `behind`, and the next check to refetch and retry even though the revision number didn't change. Pinned in Task 8 (`retries a behind profile at the same revision`).

---

## File structure

| File | Responsibility |
|---|---|
| `worker/src/code.ts` (modify) | add `SYNC_CODE_LENGTH`, `newSyncCode`, `normalizeSyncCode` |
| `worker/src/sync.ts` (create) | sync route handlers |
| `worker/src/index.ts` (modify) | route `/v1/sync…`, extend `Env`/`KvLike`, cache port |
| `worker/wrangler.jsonc`, `worker/README.md` (modify) | new rate limiters, API docs |
| `src/shared/types.ts` (modify) | `ProfileSync`, `SyncChangeSummary`, new `HmlEvent`s, `SharePreview.sync/existing` |
| `src/shared/ipc.ts` (modify) | `createSyncCode`, `stopSync`, `detachSync` |
| `src/shared/shareCode.ts` (modify) | re-export sync code helpers, `formatSyncCode` |
| `src/main/share/client.ts` (modify) | export the shared `request`/`readBody` helpers |
| `src/main/sync/client.ts` (create) | Worker client for sync routes |
| `src/main/sync/configMerge.ts` (create) | per-setting 3-way merge |
| `src/main/share/hmlFile.ts` (modify) | split out `collectHmlParts` |
| `src/main/sync/revision.ts` (create) | content digest of a revision |
| `src/main/sync/bases.ts` (create) | follower base copies under `<profileDir>/.hml-sync/base/` |
| `src/main/share/entries.ts` (create) | per-mod installer extracted from `share/service.ts` |
| `src/main/sync/apply.ts` (create) | apply a revision to a follower profile |
| `src/main/sync/service.ts` (create) | owner publish, follower check, attach/detach/stop, tick, lock check |
| `src/main/sync/lock.ts` (create) | follower lock wrapper for HmlApi |
| `src/main/services.ts`, `src/main/index.ts`, `src/main/store/paths.ts`, `src/main/profiles/profiles.ts`, `src/main/share/service.ts`, `src/main/github/service.ts` (modify) | wiring |
| `src/renderer/src/syncView.ts` (create) | toast and badge copy |
| `src/renderer/src/store.ts`, `components/ShareDialog.tsx`, `ImportDialog.tsx`, `ProfileSidebar.tsx`, `ModList.tsx` (modify) | UI |

---

### Task 1: Worker sync routes

**Files:**
- Modify: `worker/src/code.ts`, `worker/src/index.ts`, `worker/wrangler.jsonc`, `worker/README.md`
- Create: `worker/src/sync.ts`
- Test: `tests/worker/sync.test.ts` (new); `tests/worker/share.test.ts` must still pass (update its `makeEnv` for the new `Env` fields)

**Interfaces:**
- Produces (code.ts): `SYNC_CODE_LENGTH = 12`; `newSyncCode(rand?: (n: number) => Uint8Array): string`; `normalizeSyncCode(input: string): string | null`, with the same normalization as `normalizeCode` but length 12.
- Produces (index.ts):
  - `KvLike` gains `getWithMetadata<M>(key: string, type: 'arrayBuffer'): Promise<{ value: ArrayBuffer | null; metadata: M | null }>`, and `put` opts gain `metadata?: unknown`.
  - `Env` gains `SYNC_CHECK_LIMITER` and `SYNC_PUBLISH_LIMITER`, with the same shape as the existing limiters.
  - `CacheLike { match(req: Request): Promise<Response | undefined>; put(req: Request, res: Response): Promise<void>; delete(req: Request): Promise<boolean> }`.
  - `createHandler(rand?, cache?: CacheLike)`. The default export uses `caches.default`.
- HTTP API. All responses use `cache-control: no-store`.
  - `POST /v1/sync` (body: `.hml`, validated like share uploads, `SYNC_PUBLISH_LIMITER` per IP) → `201 {"code","ownerKey","revision":1}`.
  - `PUT /v1/sync/:code` with `authorization: Bearer <ownerKey>` (same body validation and limiter) → `200 {"revision":N+1}`. Errors: `401 bad-key`, `404 not-found`, `410 ended`.
  - `GET /v1/sync/:code?since=N` (`SYNC_CHECK_LIMITER`) → `304` with header `x-hml-revision` when latest ≤ N; otherwise `200` zip with `x-hml-revision`. Errors: `404`, `410 ended`.
  - `DELETE /v1/sync/:code` with bearer → `204`, and writes the tombstone.
- KV: key `s:<code>`. Value is the zip bytes, metadata `{ revision: number; keyHash: string; ended?: true }`, `expirationTtl: TTL_SECONDS`. The tombstone has an empty value with `ended: true`.
- Edge cache: meta is cached at `https://sync-meta.hml/<code>` with `max-age=60`. GET consults the cache first and answers 304 without KV when cached `revision ≤ since`. PUT and DELETE `cache.delete` that URL.
- `ownerKey`: 32 random bytes, base64url. `keyHash`: lowercase hex SHA-256 (`crypto.subtle`).

- [ ] **Step 1: Write failing tests in `tests/worker/sync.test.ts`.** Use a fake KV that stores `{value, metadata, ttl}` and a fake `CacheLike` backed by a Map:
  - `newSyncCode gives 12 Crockford chars`; `normalizeSyncCode('abcd-efgh-jkmn') === 'ABCDEFGHJKMN'`; `normalizeSyncCode` of a 10-character code is `null`; `normalizeCode` of a 12-character code is `null`.
  - `POST creates revision 1`: 201, `store.get('s:'+code).metadata.revision === 1`, `keyHash` equals the sha256 hex of the returned `ownerKey`, and ttl `=== TTL_SECONDS`.
  - `PUT with the right key bumps the revision`: `{revision: 2}`, and the stored bytes are the new body.
  - `PUT with a wrong key is 401 and changes nothing`.
  - `GET since=current is 304 with x-hml-revision and no body`; `GET since=0 is 200 with the zip`.
  - `GET with cached meta answers 304 without reading KV` (the fake KV counts `getWithMetadata` calls; the second GET adds none).
  - `PUT invalidates the cached meta` (after PUT, `GET since=1` is 200).
  - `DELETE with the key ends it`: subsequent GET is 410 `{"error":"ended"}`, and PUT is 410.
  - `rejects non-hml bodies on POST and PUT` (400 `not-an-hml`); `rate limits` (429 when the limiter fails).
  - `unknown code is 404`; `a 10-char share code on /v1/sync is 400 bad-code`.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=2 tests/worker` → the new tests FAIL (exports missing).
- [ ] **Step 3: Implement** the code helpers, `worker/src/sync.ts` (handlers taking `(req, env, cache, rand)`), and routing in `index.ts`. Reuse `readCapped`, `isZip`, `startsWithExport` and `err` by exporting them from `index.ts` or moving them into a small `worker/src/http.ts`. Add `ratelimits` to `wrangler.jsonc`: `SYNC_CHECK_LIMITER` (namespace_id `"5003"`, 30 per 60 s) and `SYNC_PUBLISH_LIMITER` (`"5004"`, 10 per 60 s). In the README, document the routes and the free-tier budget (one KV write per publish or stop; checks hit KV at most once per minute per code per colo).
- [ ] **Step 4: Run** `npx vitest run --maxWorkers=2 tests/worker` → all PASS.
- [ ] **Step 5: Commit** `feat(worker): sync code routes with cached revision checks`.

---

### Task 2: Shared types and app-side sync client

**Files:**
- Modify: `src/shared/types.ts`, `src/shared/ipc.ts`, `src/shared/shareCode.ts`, `src/main/share/client.ts`, `src/main/store/paths.ts`
- Create: `src/main/sync/client.ts`
- Test: `tests/main/sync/client.test.ts`; `tests/shared/ipc.test.ts` must still pass

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export type ProfileSync =
    | { role: 'owner'; code: string; revision: number; digest: string; pending?: true; orphaned?: true }
    | { role: 'follower'; code: string; revision: number; behind?: true; manual?: { name: string; url: string }[] }
  // ProfileManifest gains:  sync?: ProfileSync
  export interface SyncChangeSummary { added: number; removed: number; updated: number; enabled: number; disabled: number; configs: number }
  // HmlEvent gains:
  | { type: 'sync-applied'; game: string; profileId: string; profileName: string; changes: SyncChangeSummary; manual: { name: string; url: string }[] }
  | { type: 'sync-ended'; game: string; profileId: string; profileName: string }
  | { type: 'sync-state'; game: string; profileId: string }
  | { type: 'sync-error'; game: string; profileId: string; message: string }
  // SharePreview gains:  sync?: true; existing?: { game: string; profileId: string }
  ```
- Produces (`ipc.ts`, added to `HmlApi` and `METHOD_TABLE`):
  - `createSyncCode(game, profileId): Promise<{ code: string; localMods: number }>`
  - `stopSync(game, profileId): Promise<void>`
  - `detachSync(game, profileId): Promise<void>`
- Produces (`shareCode.ts`): re-export `SYNC_CODE_LENGTH` and `normalizeSyncCode`; `formatSyncCode(code): string` → `ABCD-EFGH-JKMN`.
- Produces (`paths.ts`): `syncKey(code: string): string` → `<root>/secrets/sync-<code>.bin`.
- Produces (`share/client.ts`): export the existing `request` helper and extract its streaming body reader as `readBody(res: Response, max: number): Promise<Uint8Array>` (used by `downloadShare` unchanged).
- Produces (`sync/client.ts`), all with options `{ fetch, base, timeoutMs? }` (same shape as `ShareClientOptions`):
  - `createSync(o, data: Uint8Array): Promise<{ code: string; ownerKey: string; revision: number }>`
  - `publishSync(o, code, ownerKey, data): Promise<{ revision: number }>`
  - `fetchSync(o, code, since: number): Promise<{ kind: 'unchanged'; revision: number } | { kind: 'updated'; revision: number; data: Uint8Array } | { kind: 'ended' } | { kind: 'missing' }>`
  - `endSync(o, code, ownerKey): Promise<void>`
  - Error copy: 401 → `This PC can't publish to that sync code.`; 429 → `Too many sync requests. Try again in a minute.`; anything else → `Syncing is unavailable right now.`

- [ ] **Step 1: Write failing tests** in `tests/main/sync/client.test.ts` with a fake `fetch`. Cover:
  - `createSync posts the zip and returns code, key, revision`
  - `publishSync sends the bearer key`
  - `fetchSync maps 304 to unchanged with the header revision`, `200 to updated`, `410 to ended`, `404 to missing`
  - `fetchSync passes since in the query`
  - `401 on publish throws the can't-publish message`
  - `a network error throws the unavailable message`
  - `formatSyncCode('ABCDEFGHJKMN') === 'ABCD-EFGH-JKMN'`
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=2 tests/main/sync/client.test.ts` → FAIL.
- [ ] **Step 3: Implement** the types, IPC entries (the preload exposes `HML_METHODS` automatically), `paths.syncKey`, the `share/client.ts` exports, and `sync/client.ts`. Stub the three new `HmlApi` methods in `services.ts` as `throw new Error('not yet')` so typecheck passes. Task 9 replaces the stubs.
- [ ] **Step 4: Run** the new test plus `tests/share tests/shared` → PASS; `npm run typecheck` → clean.
- [ ] **Step 5: Commit** `feat(sync): shared types and Worker client`.

---

### Task 3: Per-setting config merge

**Files:**
- Create: `src/main/sync/configMerge.ts`
- Test: `tests/main/sync/configMerge.test.ts`

**Interfaces:**
- Produces: `mergeConfig(rel: string, base: Uint8Array | null, owner: Uint8Array, local: Uint8Array | null): Uint8Array`

Rules (from spec goal 6):
- `local === null` → `owner`.
- `base` byte-equal to `owner` → `local` unchanged.
- `base === null` → treat base as empty, so every owner setting counts as changed.
- Extensions `.cfg`, `.ini`, `.toml` → sectioned line merge. `.json` → JSON leaf merge. Anything else → `owner` whole.
- Any parse failure → `owner` whole: invalid UTF-8, invalid JSON, or a TOML multi-line value (a line with `"""`, `'''`, or a value starting `[` without its closing `]` on the same line).

Sectioned line merge. Keys are `(section, key)`, where section is the last `[name]` line above and `''` before any section. Lines starting with `#` or `;` are comments:

```
changed = keys where owner value ≠ base value, or present in owner and absent in base
removed = keys present in base and absent in owner
result  = local lines, then:
  for changed keys present in local → replace only the text after '=' on that line, keeping the local spacing before the value
  for changed keys absent in local  → insert "key = value" after the last key line of that section in local (append "[section]" + line at the end if local lacks the section)
  for removed keys present in local → drop that line
keep local's BOM and line ending (CRLF vs LF) and trailing newline
```

JSON merge: recurse into plain objects. Every other value (including arrays) is a leaf compared by `JSON.stringify`. Owner-changed or added leaves are set, owner-removed leaves are deleted, and everything else keeps the local value. Output uses `JSON.stringify(result, null, indent)` with the indent detected from local (default 2), and keeps local's trailing newline.

- [ ] **Step 1: Write failing tests:**
  - `keeps the follower's keybind when the owner changes another setting in the same file`: base `[Keys]\nJump = Space\n[Game]\nDifficulty = 1`; owner Difficulty = 3; local Jump = F; result has `Jump = F` and `Difficulty = 3`.
  - `owner wins when both changed the same setting`.
  - `adds an owner-added setting into its section`; `adds a missing section at the end`.
  - `removes a setting the owner removed`.
  - `returns local byte-for-byte when the owner file equals the base`.
  - `keeps CRLF and BOM`, and lines not touched stay byte-identical.
  - `keeps BepInEx comment lines above settings`.
  - `json: merges leaves, owner wins on conflict, arrays replace whole`.
  - `unknown extension returns owner whole`; `invalid json returns owner whole`; `toml multi-line string returns owner whole`.
  - `null base counts every owner setting as changed`; `null local returns owner`.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=2 tests/main/sync/configMerge.test.ts` → FAIL.
- [ ] **Step 3: Implement** `mergeConfig`. Use `TextDecoder('utf-8', { fatal: true })` for the UTF-8 check.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sync): per-setting config merge`.

---

### Task 4: Revision parts and digest

**Files:**
- Modify: `src/main/share/hmlFile.ts`
- Create: `src/main/sync/revision.ts`
- Test: `tests/main/sync/revision.test.ts`; `tests/share/hmlFile.test.ts` must still pass

**Interfaces:**
- Produces (`hmlFile.ts`): `collectHmlParts(profile: ProfileManifest, profileDir: string, opts?: { maxBytes?: number; customGame?: HmlCustomGame }): Promise<{ export: HmlExport; configs: Map<string, Uint8Array> }>`. `buildHmlFile` becomes `zipHmlParts(await collectHmlParts(...))`, also exported, with byte-identical output to today.
- Produces (`revision.ts`): `revisionDigest(parts: { export: HmlExport; configs: Map<string, Uint8Array> }): string`. This is a hex SHA-256 over the canonical JSON of `export` (keys sorted recursively), then each config path in sorted order followed by its length and bytes. It doesn't depend on zip timestamps or Map insertion order.

- [ ] **Step 1: Write failing tests:**
  - `same content gives the same digest even when built at different times`
  - `config order does not matter`
  - `a changed config byte changes the digest`
  - `toggling a mod changes the digest`
  - `buildHmlFile still produces a readable .hml` (round-trip through `readHmlFile`)
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run --maxWorkers=2 tests/main/sync tests/share` → PASS.
- [ ] **Step 5: Commit** `feat(sync): revision digest independent of zip timestamps`.

---

### Task 5: Extract the per-mod installer from share import

A pure refactor. Behaviour and existing tests stay unchanged.

**Files:**
- Create: `src/main/share/entries.ts`
- Modify: `src/main/share/service.ts`
- Test: existing `tests/main/share/*` and `tests/share/*` must pass unchanged

**Interfaces:**
- Produces:
  ```ts
  export function modName(m: HmlExportMod): string
  export function createEntryInstaller(ctx: { deps: ServiceDeps; installers: ShareInstallers }): {
    installEntry(game: string, profileId: string, entry: HmlExportMod, refreshOnce: () => Promise<void>):
      Promise<{ modId: string; warnings: string[] } | { unresolved: UnresolvedMod }>
    tsModAt(game: string, profileId: string, fullName: string, version: string): Promise<boolean>
    /** A once-per-run Thunderstore refresh for `game`, as importShare builds today. */
    refresher(game: string): () => Promise<void>
    /** importShare's "export's version wins" pass: re-installs listed Thunderstore mods a dependency moved. */
    repinThunderstore(game: string, profileId: string, entries: HmlExportMod[], installedIds: (string | null)[]): Promise<string[]>
  }
  export async function writeConfigFiles(profileDir: string, configs: Map<string, Uint8Array>): Promise<string[]>
  ```
  `ShareInstallers` moves to `entries.ts` and is re-exported from `share/service.ts`.

- [ ] **Step 1: Run** `npx vitest run --maxWorkers=2 tests/main/share tests/share` → record a green baseline.
- [ ] **Step 2: Move** `modName`, `findPackage`, `installEntry`, `onThunderstore`, `tsModAt`, the repin loop and `writeConfigs` (renamed `writeConfigFiles`, taking the profile dir) into `entries.ts`. `importShare` calls them. Don't change copy or ordering.
- [ ] **Step 3: Run** the same tests plus `npm run typecheck` → PASS, same counts as the baseline.
- [ ] **Step 4: Commit** `refactor(share): extract per-mod installer for reuse`.

---

### Task 6: Apply a revision to a follower profile

**Files:**
- Create: `src/main/sync/bases.ts`, `src/main/sync/apply.ts`
- Test: `tests/main/sync/apply.test.ts`, `tests/main/sync/bases.test.ts`

**Interfaces:**
- Consumes: `createEntryInstaller`, `modName` (Task 5); `mergeConfig` (Task 3); `SyncChangeSummary` (Task 2).
- Produces (`bases.ts`). The base dir is `<profileDir>/.hml-sync/base/`, holding config paths as-is:
  - `readBases(profileDir): Promise<Map<string, Uint8Array>>`
  - `writeBases(profileDir, configs: Map<string, Uint8Array>): Promise<void>`, which replaces the whole set
  - `clearBases(profileDir): Promise<void>`
- Produces (`apply.ts`):
  ```ts
  export function modKey(s: ModSource): string
  // 'ts:<fullName>' | 'gh:<owner>/<repo>' (lowercased) | 'nx:<domain>:<modId>' | 'local:<fileName>'
  export interface SyncApplyResult extends SyncChangeSummary {
    manual: { name: string; url: string }[]
    failed: UnresolvedMod[]
  }
  export interface ApplyContext {
    deps: ServiceDeps
    serialize<T>(game: string, profileId: string, fn: () => Promise<T>): Promise<T>
    installers: ShareInstallers & Pick<HmlApi, 'uninstallMod'>
    entries: ReturnType<typeof createEntryInstaller>
  }
  export async function applyRevision(ctx: ApplyContext, game: string, profileId: string,
    rev: { export: HmlExport; configs: Map<string, Uint8Array> }): Promise<SyncApplyResult>
  ```

The algorithm (it decides counting and order, which the tests pin):
1. `desired` = `rev.export.mods` without `local` sources. `current` = profile mods.
2. Uninstall each current mod whose `modKey` isn't in desired → `removed++`.
3. For each desired entry: if current has the same key at the same version (`compareVersions === 0`), skip. Otherwise call `installEntry`, counting `updated++` if the key existed and `added++` if not. Collect results: an `unresolved` with a `url` goes to `manual`, any other `unresolved` goes to `failed`.
4. `repinThunderstore`.
5. For each desired entry that's installed, if its enabled state differs from the entry's, call `setModEnabled` → `enabled++` or `disabled++`.
6. Under `serialize`: for each owner config, compute `merged = mergeConfig(rel, bases.get(rel) ?? null, owner, localBytesOrNull)`, write it if it differs from local (`configs++`), then `writeBases(profileDir, rev.configs)`. Use the same path-safety check as `writeConfigFiles`.

- [ ] **Step 1: Write failing tests**, with a temp profile dir and fake installers that record calls and edit the manifest:
  - `removes mods the owner removed`
  - `installs mods the owner added`
  - `moves a mod to the owner's version and counts it as updated`
  - `matches enabled states`
  - `skips the owner's local mods and does not remove them from the count`
  - `a nexus open-website result lands in manual with its url`
  - `a failed download lands in failed and the rest still applies`
  - `merges configs against bases and then stores the owner's files as the new bases`
  - `leaves a follower-only config file alone`
  - `bases: write replaces the set; clear removes the dir`
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=2 tests/main/sync/apply.test.ts tests/main/sync/bases.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sync): apply a revision to a follower profile`.

---

### Task 7: Sync service — owner side

**Files:**
- Create: `src/main/sync/service.ts`
- Test: `tests/main/sync/owner.test.ts`

**Interfaces:**
- Consumes: `collectHmlParts`, `zipHmlParts` (Task 4); `revisionDigest`; `createSync`/`publishSync`/`endSync` (Task 2); `loadSecret`/`saveSecret` (`src/main/secrets.ts`); `noSecureStorage` (`src/shared/messages.ts`).
- Produces:
  ```ts
  export const SYNC_DEBOUNCE_MS = 10_000
  export const SYNC_POLL_MS = 300_000
  export const SYNC_HOLD_RETRY_MS = 30_000
  export const SYNC_LAUNCH_CHECK_MS = 10_000
  export interface SyncTimers { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void }
  export interface SyncContext {
    deps: ServiceDeps
    /** The raw profile lock: must NOT notify `touched`, or publishing would re-trigger itself. */
    lock<T>(game: string, profileId: string, fn: () => Promise<T>): Promise<T>
    requireGame(label: string): Promise<GameDef>
    getCustomGame(label: string): Promise<HmlCustomGame | null>
    /** isGameProcessRunning === true for the game's exes. */
    isGameRunning(def: GameDef): Promise<boolean>
    apply(game: string, profileId: string, rev: { export: HmlExport; configs: Map<string, Uint8Array> }): Promise<SyncApplyResult>
    timers?: SyncTimers
  }
  export function createSyncServices(ctx: SyncContext): {
    createSyncCode(game: string, profileId: string): Promise<{ code: string; localMods: number }>
    stopSync(game: string, profileId: string): Promise<void>
    touched(game: string, profileId: string): void
    publishNow(game: string, profileId: string): Promise<void>
    /** Owner: forget the key file (used by deleteProfile). */
    forgetOwnerKey(code: string): Promise<void>
    // follower members are added in Task 8
  }
  ```

Behaviour:
- `createSyncCode`:
  - If the profile is already the owner → return its code, with `localMods` counted.
  - If it's a follower → throw `Detach this profile from its sync before creating a sync code.`
  - If `!deps.secrets.isAvailable()` → throw `noSecureStorage('sync codes')`.
  - Otherwise collect the parts, zip, `createSync`, then `saveSecret(paths.syncKey(code), …, 'sync codes')`. If saving fails, best-effort `endSync`, then rethrow.
  - Save `sync = { role: 'owner', code, revision, digest }` under `lock`, then emit `sync-state`.
- `touched`: ignores `profileId === '__deploy__'`, then restarts that profile's `SYNC_DEBOUNCE_MS` timer, which calls `publishNow`. It's cheap: it doesn't read the manifest.
- `publishNow`:
  - Read the profile, return unless it's the owner, and collect parts under `lock`.
  - If the digest equals `sync.digest` → clear `pending` if set, and return.
  - Load the key. If it's missing → set `orphaned: true, pending: true`, emit `sync-state`, and return.
  - `publishSync`. On success → save `{revision, digest}` with `pending` cleared. On `ended`/`missing` (the server reports 410/404) → set `orphaned`. On other errors → set `pending: true`. Emit `sync-state` after each state change.
  - Only one publish per profile is in flight. A `touched` during a publish schedules a follow-up.
- `stopSync`:
  - Owner: `endSync` (a 404/410 counts as already ended), then delete the key file and remove `sync` from the manifest.
  - Follower: throw (followers use `detachSync`).
  - Emit `sync-state`.

- [ ] **Step 1: Write failing tests** with a fake `fetch`, fake secrets, fake timers and a temp profile:
  - `createSyncCode publishes revision 1 and stores the key and owner state`
  - `createSyncCode returns the existing code for an owner profile`
  - `createSyncCode refuses without secure storage and never calls fetch`
  - `createSyncCode refuses on a follower profile`
  - `touched debounces several edits into one publish after SYNC_DEBOUNCE_MS`
  - `does not publish when only file timestamps change` (rewrite a config with identical bytes, then `publishNow` → no fetch)
  - `publishes when a config value changes`
  - `a failed publish marks pending and the next publishNow retries`
  - `a missing key marks the profile orphaned`
  - `stopSync ends the code, deletes the key and clears sync`
  - `touched ignores the deploy lock key`
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=2 tests/main/sync/owner.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sync): owner publishing with debounce and digest check`.

---

### Task 8: Sync service — follower side and import

**Files:**
- Modify: `src/main/sync/service.ts`, `src/main/share/service.ts`
- Test: `tests/main/sync/follower.test.ts`; share import tests extended in `tests/main/share/` (the existing import test file)

**Interfaces:**
- Consumes: `fetchSync` (Task 2), `readHmlFile`, `writeBases`/`clearBases` (Task 6), `SharePreview.sync/existing` (Task 2).
- Produces (added to the object `createSyncServices` returns):
  ```ts
  detachSync(game: string, profileId: string): Promise<void>
  checkFollower(game: string, profileId: string): Promise<void>
  beforeLaunch(game: string, profileId: string): Promise<void>
  /** Startup and every SYNC_POLL_MS: check followers, publishNow owners, prune manual lists. */
  tick(): Promise<void>
  attachFollower(game: string, profileId: string, code: string, revision: number, configs: Map<string, Uint8Array>): Promise<void>
  findByCode(code: string): Promise<{ game: string; profileId: string } | null>
  /** True while applyRevision runs for this profile (lets the follower lock pass). */
  isApplying(game: string, profileId: string): boolean
  isFollower(game: string, profileId: string): Promise<boolean>
  ```
- Produces (`ShareContext` gains): `sync: { fetchLatest(code: string): Promise<{ revision: number; data: Uint8Array }>; findByCode: …; attachFollower: … }`, passed in late-bound from `services.ts`.

Behaviour of `checkFollower`:
- Only one run per profile at a time. A second call while one runs returns that run's promise.
- `since = sync.behind ? 0 : sync.revision`.
- `ended`/`missing` → clear `sync`, `clearBases`, emit `sync-ended`.
- `unchanged` → return.
- `updated` → `readHmlFile(data, { forImport: true })`. A read failure → emit `sync-error` with `Update HML to keep following <profile name>.`, once per revision (remember it in memory). If `export.game !== game`, ignore it with a `console.warn`.
- If `ctx.isGameRunning(def)` → hold: schedule `checkFollower` again after `SYNC_HOLD_RETRY_MS` and return.
- Otherwise set `isApplying` and run `ctx.apply`. Then save `sync = { role: 'follower', code, revision, behind: failed.length > 0 || undefined, manual: manual.length ? manual : undefined }` and emit `sync-applied` (only when any count, `manual` or `failed` is non-zero), then `sync-state`. Clear `isApplying` in `finally`.
- Network errors are logged and swallowed. A `checkFollower` never throws.

`beforeLaunch` races `checkFollower` against `SYNC_LAUNCH_CHECK_MS`. If the check is mid-apply when the timeout hits, it waits for the apply to finish. It never throws.

`detachSync`: follower only. Clears `sync` and `clearBases`, then emits `sync-state`.

`tick`: walks `paths.gamesDir` → each game's `listProfiles`.
- Followers: `checkFollower`. If `manual` is non-empty, first drop entries whose mod is now installed (matched by name/mod id via the Nexus URL's mod id).
- Owners: `publishNow`.
- A failure on one profile doesn't stop the others.

Import (`share/service.ts`):
- `previewShare({code})`: when `normalizeSyncCode(code)` matches → `existing = await sync.findByCode(code)`. If there's an existing profile, return a minimal preview `{ token: '', game, gameName, profileName, mods: [], configFiles: 0, sync: true, existing }` without downloading. Otherwise `fetchLatest(code)` (`missing`/`ended` → throw `No synced profile has that code. It may have ended.`), then read it as an `.hml` and hold it as pending with `sync: { code, revision }`. The preview has `sync: true`.
- `importShare`: after configs are written, if the pending entry has `sync` → `attachFollower(game, profileId, code, revision, held.configs)`, which saves the follower state and writes the bases. Any failure there becomes a warning, not a thrown error.

- [ ] **Step 1: Write failing tests:**
  - `applies a newer revision and emits sync-applied with the counts`
  - `does nothing when unchanged`
  - `holds while the game runs and retries after SYNC_HOLD_RETRY_MS`
  - `an ended code detaches the profile and emits sync-ended`
  - `retries a behind profile at the same revision` (since=0 on the next check)
  - `runs one check per profile at a time` (two concurrent calls → one fetch, one apply)
  - `beforeLaunch gives up after the timeout` (fetch never resolves → resolves after `SYNC_LAUNCH_CHECK_MS`)
  - `a newer-format revision emits the update-HML error once`
  - `isApplying is true only during apply`
  - `detachSync clears sync and bases`
  - `tick prunes manual entries that are now installed`
  - Share tests: `previewShare of a followed sync code returns existing without downloading`; `importShare of a sync code attaches the follower and writes bases`; `a share code still imports as before`.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=2 tests/main/sync tests/main/share` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sync): follower checks, apply and sync-code import`.

---

### Task 9: Wire sync into services and startup

**Files:**
- Create: `src/main/sync/lock.ts`
- Modify: `src/main/services.ts`, `src/main/index.ts`, `src/main/profiles/profiles.ts`, `src/main/github/service.ts`
- Test: `tests/main/sync/lock.test.ts`; extend `tests/main/services.test.ts`; `tests/main/profiles/*`

**Interfaces:**
- Produces (`lock.ts`):
  ```ts
  export const FOLLOWER_LOCKED = ['installFromFile','installFromPaths','setModEnabled','uninstallMod','setModHeld',
    'tsInstall','tsUpdate','ghInstall','ghUpdate','ghSetUpdateMode','ghSetPrereleases','ghInstallRelease',
    'nxInstall','nxUpdate','installLoader'] as const satisfies readonly (keyof HmlApi)[]
  export const FOLLOWER_LOCKED_MESSAGE = 'This profile is synced from a friend. Detach it to change its mods.'
  export function lockFollowers<T extends HmlApi>(api: T, guard: { isFollower(game: string, profileId: string): Promise<boolean>; isApplying(game: string, profileId: string): boolean }): T
  ```
  Each listed method checks `(args[0], args[1])` and throws the message when the profile is a follower and not applying.
- Produces (`createServices` return gains): `syncTick(): Promise<void>`.

Steps in `services.ts`:
- Rename the existing `serialize` to `lock`. Define `serialize = (g, p, fn) => lock(g, p, fn).finally(() => sync.touched(g, p))`, with `sync` late-bound because it's created after. Every existing consumer (TS, GitHub, Nexus, share services) keeps receiving `serialize`. The sync service receives `lock`.
- Create `sync = createSyncServices({ deps, lock, requireGame, getCustomGame, isGameRunning: def => isGameProcessRunning(...).then(r => r === true).catch(() => false), apply })`. `apply` = `applyRevision` with `installers` = the same in-process methods `createShareServices` gets, plus `uninstallMod`.
- Pass `sync` into `createShareServices` (Task 8's `ShareContext.sync`).
- Add `createSyncCode`, `stopSync` and `detachSync` from `sync` to the returned API, replacing the Task 2 stubs. Wrap the whole returned object with `lockFollowers(…, sync)`.
- `launch`: when `mode === 'modded' && profileId`, `await sync.beforeLaunch(game, profileId)` before anything else.
- `deleteProfile`: if the profile is the owner, `sync.forgetOwnerKey(code)` after deleting. The renderer asks whether to `stopSync` first.
- Background update checks (`profiles:` passed to background checks) skip `sync?.role === 'follower'`.

Elsewhere:
- `github/service.ts` `runAutoUpdate` skips follower profiles.
- `profiles.ts` `duplicateProfile`: the copy filter also skips `<profileDir>/.hml-sync`. The copy already gets no `sync` field because it builds `{ ...created, mods }`; pin that with a test.
- `index.ts`: alongside the GitHub check timer, `setTimeout(() => { void ready.syncTick(); setInterval(() => void ready.syncTick(), SYNC_POLL_MS) }, 10_000)`.

- [ ] **Step 1: Write failing tests:**
  - lock: `refuses each locked method on a follower`; `lets them through while applying`; `leaves owners and plain profiles alone`; `does not lock writeConfig, launch, renameProfile`.
  - services: `launch modded on a follower runs the pre-launch check first`; `background checks skip followers`; `deleting an owner profile removes its key file`; `a mutation on an owner profile schedules a publish`.
  - profiles: `duplicate of a synced profile is a plain profile without .hml-sync`.
  - github: `auto-update skips follower profiles`.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=2 tests/main/sync/lock.test.ts tests/main/services.test.ts tests/main/profiles tests/main/github` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`, `npm run typecheck` and `npm run lint` → all clean.
- [ ] **Step 5: Commit** `feat(sync): wire synced profiles into services and startup`.

---

### Task 10: Renderer UI

**Files:**
- Create: `src/renderer/src/syncView.ts`
- Modify: `src/renderer/src/store.ts`, `components/ShareDialog.tsx`, `components/ImportDialog.tsx`, `components/ProfileSidebar.tsx`, `components/ModList.tsx` (plus `Browse.tsx`/`NexusBrowse.tsx`/`GithubDialog.tsx` install buttons, which disable on a follower)
- Test: `tests/renderer/syncView.test.ts`, extend `tests/renderer/store.test.ts`

**Interfaces:**
- Consumes: `ProfileSync`, sync events (Task 2), `formatSyncCode`, the new `HmlApi` methods.
- Produces (`syncView.ts`):
  - `syncUpdatedToast(profileName: string, c: SyncChangeSummary): string`. Copy, with parts in this order and omitted when zero: `"<name> updated: +2 mods, 1 removed, 1 updated, 1 enabled, 1 disabled, configs changed"`. When every count is 0 it returns `"<name> updated"`.
  - `manualDownloadToast(n: number): string` → `"1 mod needs a manual download"` / `"3 mods need a manual download"`.
  - `syncBadge(sync: ProfileSync | undefined): { label: 'Syncing' | 'Sync pending' | "Can't sync" | 'Synced'; tone: 'teal' | 'warn' | 'muted' } | null`. Owner → `Syncing` (teal), `Sync pending` (warn) when `pending`, and `Can't sync` (warn) when `orphaned`. Follower → `Synced` (muted). Undefined → null.
  - `isFollower(p: ProfileManifest): boolean`.
  - `SYNC_LOCKED_NOTE = 'Synced from a friend. Detach to change mods.'`

UI behaviour:
- **ShareDialog**, below the share-code section:
  - Owner: shows the sync code (`formatSyncCode`), Copy, and "Stop syncing" (confirm: `Friends will keep their current copy, but it won't update anymore.`).
  - Plain profile: "Create sync code" with the explanation `Friends who import a sync code get your changes automatically.`, and `localModsNote` when `localMods > 0`.
  - Follower: no sync section.
- **ImportDialog**: if the preview has `existing` → `openImportedProfile(existing.game, existing.profileId)`, toast `You already have this synced profile`, close. If `preview.sync` → the header says "Synced profile" and the Import button says "Import and follow".
- **ProfileSidebar**: a badge from `syncBadge`. The menu gets "Stop syncing…" (owner) or "Detach from sync…" (follower; confirm: `It becomes a normal profile and stops getting updates.`). Deleting an owner profile shows a confirm with a checkbox, checked by default, "Also stop syncing for friends". When checked, call `stopSync` before `deleteProfile`.
- **ModList and install surfaces**: when `isFollower(current profile)`, a banner with `SYNC_LOCKED_NOTE`, and toggle, uninstall, update, hold and install controls are disabled. The config editor stays enabled. On an owner profile, each `local` mod row shows a warn-toned marker `Won't sync to friends` (spec goal 1).
- **store.ts** events:
  - `sync-applied` → `toast('success', syncUpdatedToast(…))`. If `manual.length` → `toast('info', manualDownloadToast(n), { label: 'Open', run: () => urls.slice(0, NX_MAX_UPDATE_TABS).forEach(openExternal) })`. Then reload profiles if `game` is current.
  - `sync-ended` → `toast('info', '<name> is no longer synced')`, then reload.
  - `sync-state` → reload profiles if `game` is current.
  - `sync-error` → `toast('error', message)`.

- [ ] **Step 1: Write failing tests** for every `syncView` function (each copy string above, zero-omission, singular/plural, badge per state), and store tests: `sync-applied toasts and reloads the current game's profiles`, `sync-applied with manual adds an Open action`, `sync-ended toasts`.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=2 tests/renderer/syncView.test.ts tests/renderer/store.test.ts` → FAIL.
- [ ] **Step 3: Implement** `syncView.ts`, the store handlers and the components.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck` and `npm run lint` → clean.
- [ ] **Step 5: Manual check (run skill):** `npm run dev` with `HML_SHARE_URL` pointing at `npx wrangler@4 dev` in `worker/`:
  - Create a sync code.
  - Import it into a second profile (the same HML install is fine; the follower is a different profile).
  - Toggle a mod and edit a config value on the owner. After about 10 s plus the next tick (temporarily lower `SYNC_POLL_MS` locally, and don't commit that), the follower gets the toast and matches.
  - A follower-only keybind edit survives.
  - The follower's mod controls are disabled.
  - Detach works.
- [ ] **Step 6: Commit** `feat(sync): synced profile UI`.

---

## Rollout note (not a task)

Deploy the Worker (`cd worker && npx wrangler@4 deploy`) before releasing an HML build that includes this. Old Worker deployments 404 on `/v1/sync`, which the client surfaces as "Syncing is unavailable right now."
