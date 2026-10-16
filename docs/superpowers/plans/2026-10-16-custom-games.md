# Custom Games Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make games outside Thunderstore and Nexus (installed Steam games and folder-added games) first-class HML games, with BepInEx installed per profile from BepInEx's GitHub releases, r2modman-style launches, and share-code support.

**Architecture:** A new `src/main/custom/` area holds the custom-games store, folder detection, loader specs and manual-install cleanup; `createCustomGameServices` (like `createNexusServices`/`createShareServices`) exposes them through `HmlApi`. Custom games are merged into `getCatalog()` as ordinary `GameDef`s with `loader: 'bepinex'` or `'deploy'` plus a new `custom` field, so the existing install, launch and deploy paths apply. GitHub releases gain a "track" (major version + pre-release flag) so the BepInEx loader mod updates within its line.

**Tech Stack:** Electron, TypeScript, React, Zustand store, Vitest (node env), zod (share files).

**Spec:** `docs/superpowers/specs/2026-10-16-custom-games-design.md`

## Global Constraints

- Run tests with `npx vitest run --maxWorkers=2 <path>`; the full suite with `npx vitest run --maxWorkers=2`. Typecheck with `npm run typecheck`, lint with `npm run lint`.
- Tests never hit the network or use the user's tokens; fake `fetch`, `execFile`, `spawn` and Steam folders in a temp dir, as `tests/main/services.test.ts` does.
- Commit by file name (never `git add -A`); every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never hold two profile locks at once; `serialize` is not re-entrant (service methods that take a profile lock must not be called from inside that lock).
- Catalog and Nexus-only games must behave exactly as before (spec anti-goal "Breaking anything about catalog or Nexus games"). Existing tests stay green.
- Copy rules (verbatim from the spec):
  - Manual-install prompt: `<Game> has BepInEx installed in its game folder. HML manages mods per profile and only loads them when you launch through HML. Remove the manual install?` with buttons `Remove` and `Keep`.
  - Menu item: `Remove manual BepInEx install…`
  - Native Linux add dialog: `Force Proton in the game's Steam properties, then add it again`
  - Recommended loader label form: `Unity (Mono) — BepInEx 5, recommended`
  - Search group heading: `Installed on Steam`; picker action: `Add a game by folder…`
  - Loader switch action: `Switch to <loader>`
- Labels: `steam-<appid>` for Steam custom games; `custom-<slug>` for folder games (slug of the folder name; the `custom-` prefix keeps them from colliding with catalog labels).
- Loader choices offered: BepInEx 5 (Mono), BepInEx 6 (Mono), BepInEx 6 (IL2CPP), No loader. BepInEx 5 never moves to 6; the 6 choices track the newest 6.x including pre-releases.

## Review Focus

1. **Game library on another filesystem than HML's data dir** (Trash Day lives on `/var/mnt/data`, HML's data in `~/.config`): moving a manual install to the backup folder must work across devices (copy then delete, never a bare `rename`). Test in Task 7.
2. **A Steam library listed in `libraryfolders.vdf` that is missing or unreadable** (unmounted drive): search still returns the other libraries' games, no error. Test in Task 2.
3. **Doorstop 3 vs 4 ini in the game folder after a modded launch**: the copied `doorstop_config.ini` must be disabled for both formats (`[UnityDoorstop] enabled=true` and `[General] enabled = true`) while `debug_enabled`-style keys are untouched. Test in Task 6.
4. **A BepInEx release with no asset matching the choice** (e.g. a future 6.x release renaming its zips): installing the loader fails with a readable message naming the repo and tag, and nothing in the profile changes. Test in Task 9.
5. **Removing a custom game whose mods are deployed** (no-loader game): removal is refused with a readable message instead of orphaning files in the game folder. Test in Task 8.

---

## File Structure

Create:
- `src/main/steam/installedApps.ts` — enumerate installed Steam apps across libraries; filter tools/runtimes.
- `src/main/custom/detect.ts` — inspect a game folder: exe, data folder, engine, suggested loader.
- `src/main/custom/customGames.ts` — `custom-games.json` store, label slugs, `customGameDef`.
- `src/main/custom/loaders.ts` — the four loader choices: GitHub repo, asset pattern, release track, labels.
- `src/main/custom/manualInstall.ts` — find and back up a hand-installed BepInEx in a game folder.
- `src/main/launch/runners.ts` — find Proton versions and Wine for folder games on Linux.
- `src/main/custom/service.ts` — `createCustomGameServices`: the new `HmlApi` methods.
- `src/renderer/src/components/AddGameDialog.tsx` — loader/name/runner dialog for adding and editing a custom game.
- `src/renderer/src/components/ManualLoaderDialog.tsx` — the Remove/Keep prompt.
- `src/renderer/src/customView.ts` — pure helpers for the UI (loader labels, source availability).
- Tests: `tests/main/steam/installedApps.test.ts`, `tests/main/custom/detect.test.ts`, `tests/main/custom/customGames.test.ts`, `tests/main/custom/loaders.test.ts`, `tests/main/custom/manualInstall.test.ts`, `tests/main/launch/runners.test.ts`, `tests/main/custom/service.test.ts`, `tests/renderer/customView.test.ts`.

Modify:
- `src/shared/types.ts`, `src/shared/ipc.ts`, `src/main/store/settings.ts`, `src/main/store/paths.ts`
- `src/main/nexus/games.ts` (Nexus-only identity by label prefix, not `loader === 'deploy'`)
- `src/main/github/api.ts`, `src/main/github/service.ts` (release tracks)
- `src/main/launch/launchPlan.ts`, `src/main/launch/launcher.ts` (direct launches, inert doorstop ini, env/cwd)
- `src/main/services.ts` (catalog merge, search group, createProfile, warnings, launch, wiring)
- `src/main/share/hmlFile.ts`, `src/main/share/service.ts`
- `src/renderer/src/store.ts`, `GamePicker.tsx`, `ProfileSidebar.tsx`, `LaunchBar.tsx`, `ModList.tsx`, `Browse.tsx`, `ImportDialog.tsx`

---

### Task 1: Shared types, settings and paths

**Files:**
- Modify: `src/shared/types.ts`, `src/main/store/settings.ts`, `src/main/store/paths.ts`
- Test: `tests/main/store/settings.test.ts` (existing file; add cases)

**Interfaces:**
- Produces (in `src/shared/types.ts`):
  ```ts
  export type LoaderChoice = 'bepinex5' | 'bepinex6-mono' | 'bepinex6-il2cpp' | 'none'
  export type Runner = { kind: 'proton'; name: string; path: string } | { kind: 'wine' }
  export interface CustomGameInfo {
    source: 'steam' | 'folder'
    loaderChoice: LoaderChoice
    /** Folder games on Linux: how HML starts the exe. null = none chosen/found. */
    runner?: Runner | null
    /** False only for an installed Steam game shown in search that isn't added yet. */
    added: boolean
  }
  export interface GameDetection {
    exeName: string | null
    dataFolderName: string
    engine: 'unity-mono' | 'unity-il2cpp' | 'unknown'
    /** No Windows .exe in the folder (a native Linux build). */
    nativeLinux: boolean
    suggested: LoaderChoice
  }
  export interface GhTrack { major: number; prerelease: boolean }
  export interface HmlCustomGame {
    source: 'steam' | 'folder'
    displayName: string
    steamAppId: string | null
    loaderChoice: LoaderChoice
  }
  ```
  - `GameDef.custom?: CustomGameInfo`
  - `GhModConfig.track?: GhTrack`
  - `Settings.manualLoaderKept: string[]` (game labels whose manual install the user chose to keep)
  - `LaunchWarning` gains `'loader-mismatch'` and `'no-runner'`
  - `HmlExport.customGame?: HmlCustomGame`
  - `SharePreview.needsFolder?: boolean`
- Produces (in `AppPaths`): `customGames: string` (`<root>/custom-games.json`), `winePrefix(label: string): string` (`<root>/prefixes/<label>`), `loaderBackup(label: string, stamp: string): string` (`<root>/backups/<label>/<stamp>`).

- [ ] **Step 1: Write the failing tests** in `tests/main/store/settings.test.ts`:
  - `test('defaultSettings has no kept manual loaders')` — `expect(defaultSettings().manualLoaderKept).toEqual([])`.
  - `test('normalizeSettings keeps string entries of manualLoaderKept and drops the rest')` — input `{ manualLoaderKept: ['steam-1', 5, null, 'repo'] }` → `['steam-1', 'repo']`; input `{ manualLoaderKept: 'x' }` → `[]`.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=2 tests/main/store/settings.test.ts` — expect FAIL (`manualLoaderKept` undefined).
- [ ] **Step 3: Implement** the types above, `manualLoaderKept` in `defaultSettings`/`normalizeSettings`, and the three `AppPaths` entries in `makePaths`. `saveSettings` in `services.ts` must keep passing `manualLoaderKept` through unchanged (it spreads `cur`, so it does; confirm).
- [ ] **Step 4: Run** the test file and `npm run typecheck` — expect PASS (fix any exhaustive `LaunchWarning` maps the compiler flags, e.g. the warning copy table in `LaunchBar.tsx`, with placeholder text that Task 12 replaces: `'loader-mismatch': 'This profile has a different BepInEx than the game is set to.'`, `'no-runner': 'Choose how to run this game (Proton or Wine) from the game menu.'`).
- [ ] **Step 5: Commit** `src/shared/types.ts src/main/store/settings.ts src/main/store/paths.ts tests/main/store/settings.test.ts` (plus `LaunchBar.tsx` if touched): `feat(types): custom game, loader choice and release track types`.

---

### Task 2: Installed Steam apps

**Files:**
- Create: `src/main/steam/installedApps.ts`
- Test: `tests/main/steam/installedApps.test.ts`

**Interfaces:**
- Consumes: `listLibraries(root)` from `src/main/steam/steam.ts`; `parseVdf`, `vdfGet` from `./vdf`.
- Produces:
  ```ts
  export interface InstalledApp { appId: string; name: string; installDir: string }
  export function isSteamTool(app: { appId: string; name: string }): boolean
  export async function listInstalledApps(root: string): Promise<InstalledApp[]>
  ```
  `listInstalledApps` reads every `appmanifest_<id>.acf` in each library's `steamapps`, keeps apps whose `AppState.StateFlags` has bit 4 (fully installed), whose `installdir` is a single safe segment (same rule as `findAppInstall`) and whose folder `steamapps/common/<installdir>` exists, drops `isSteamTool` apps, de-duplicates by appId (first library wins), sorted by name (case-insensitive).
  `isSteamTool` is true for app ids `228980` (Steamworks Common Redistributables), `1070560`, `1391110`, `1628350`, `4183110` (Steam Linux Runtimes), `1493710` (Proton Experimental), `2180100` (Proton Hotfix), `1826330`, `1161040` (Proton EAC/BattlEye runtimes), `250820` (SteamVR), and for names matching `/^Proton\b/i`, `/^Steam Linux Runtime/i`, `/^Steamworks\b/i`, `/\bSoundtrack\b/i`, `/\bOST$/i`, `/\bDemo$/i`, `/\bDedicated Server$/i`.

- [ ] **Step 1: Write the failing tests** (build a fake Steam root in `mkdtemp`: `steamapps/libraryfolders.vdf` listing the root and a second library; write `.acf` files with `"AppState" { "appid" "…" "name" "…" "installdir" "…" "StateFlags" "4" }`):
  - `lists installed games from every library, sorted by name` — Trash Day (3314580, `TrashDay`) in library 2 and `Alpha` in the root → `[{appId:'…',name:'Alpha',…},{appId:'3314580',name:'Trash Day',installDir:<lib2>/steamapps/common/TrashDay}]`.
  - `drops tools, runtimes, soundtracks and demos` — manifests for `Proton 9.0`, appid `1628350`, `Foo Soundtrack`, `Bar Demo` → none listed.
  - `drops apps that are not fully installed or whose folder is missing` — `StateFlags "1026"` (no bit 4: 1026 & 4 === 0) and a manifest whose folder doesn't exist → not listed.
  - `rejects unsafe installdir values` — `installdir` `../evil` → not listed.
  - `skips a library that is listed but missing` (Review Focus 2) — `libraryfolders.vdf` names `/nonexistent/lib`; the root's games are still returned, no throw.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=2 tests/main/steam/installedApps.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `src/main/steam/installedApps.ts` per the interface. Read each library's `steamapps` dir with `readdir`, ignoring errors per library; match `/^appmanifest_(\d+)\.acf$/`.
- [ ] **Step 4: Run** the test file — expect PASS.
- [ ] **Step 5: Commit** both files: `feat(steam): list installed Steam games without tools and runtimes`.

---

### Task 3: Folder detection

**Files:**
- Create: `src/main/custom/detect.ts`
- Test: `tests/main/custom/detect.test.ts`

**Interfaces:**
- Produces: `export async function detectGameFolder(dir: string): Promise<GameDetection>`
  Rules (spec goal 3 and the native-Linux designer call):
  - Exe: top-level `*.exe` files (case-insensitive), ignoring names matching `/^UnityCrashHandler(32|64)?\.exe$/i`, `/^unins\d*\.exe$/i`, `/crash|setup|redist|vc_redist/i`. If a top-level folder `<X>_Data` exists and `<X>.exe` exists, `exeName = '<X>.exe'`, `dataFolderName = '<X>_Data'`. Otherwise, if exactly one exe remains, it is `exeName` and `dataFolderName` is `''`. Otherwise `exeName = null`.
  - `nativeLinux = true` when no top-level `.exe` exists at all.
  - `unity-il2cpp` when `GameAssembly.dll` exists at top level and `<dataFolder>/il2cpp_data` is a folder → suggested `'bepinex6-il2cpp'`.
  - `unity-mono` when `<dataFolder>/Managed/Assembly-CSharp.dll` exists, or `UnityPlayer.dll` exists with a `<dataFolder>/Managed` folder → suggested `'bepinex5'`.
  - Otherwise `unknown` → `'none'`. `nativeLinux` always forces `suggested: 'none'` (engine is still reported).
  - A missing or unreadable `dir` throws `Error("Couldn't read the game folder <dir>.")`.

- [ ] **Step 1: Write the failing tests** (build folders in `mkdtemp`; empty files are fine):
  - `detects a Unity Mono game (Trash Day layout)` — `Trash.exe`, `UnityPlayer.dll`, `UnityCrashHandler64.exe`, `MonoBleedingEdge/`, `Trash_Data/Managed/Assembly-CSharp.dll` → `{ exeName: 'Trash.exe', dataFolderName: 'Trash_Data', engine: 'unity-mono', nativeLinux: false, suggested: 'bepinex5' }`.
  - `detects a Unity IL2CPP game` — `Game.exe`, `GameAssembly.dll`, `Game_Data/il2cpp_data/` → `engine: 'unity-il2cpp'`, `suggested: 'bepinex6-il2cpp'`.
  - `suggests no loader for a non-Unity game with one exe` — `Thing.exe`, `data.pak` → `{ exeName: 'Thing.exe', dataFolderName: '', engine: 'unknown', suggested: 'none' }`.
  - `offers no loader for a native Linux build` — `Game.x86_64`, `Game_Data/Managed/Assembly-CSharp.dll` → `{ exeName: null, nativeLinux: true, engine: 'unity-mono', suggested: 'none' }`.
  - `leaves exeName null when several exes are ambiguous` — `a.exe`, `b.exe` → `exeName: null`.
  - `throws a readable error for a missing folder`.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=2 tests/main/custom/detect.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `detectGameFolder`. Match `<X>_Data` and `<X>.exe` case-insensitively but return the names as they are on disk.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit**: `feat(custom): detect a game folder's exe, engine and loader`.

---

### Task 4: Custom games store and Nexus-only identity

**Files:**
- Create: `src/main/custom/customGames.ts`
- Modify: `src/main/nexus/games.ts:69-70`
- Test: `tests/main/custom/customGames.test.ts`; `tests/main/nexus/games.test.ts` (existing; add a case)

**Interfaces:**
- Consumes: `AppPaths.customGames`; `readJson`, `writeJsonAtomic` from `src/main/store/json.ts`.
- Produces:
  ```ts
  export interface StoredCustomGame {
    label: string
    source: 'steam' | 'folder'
    displayName: string
    steamAppId: string | null
    loaderChoice: LoaderChoice
    exeName: string | null
    dataFolderName: string
    runner?: Runner | null
  }
  export const BEPINEX_INSTALL_RULES: InstallRule[]
  export function folderLabel(folderName: string, taken: Set<string>): string
  export function customGameDef(g: StoredCustomGame): GameDef
  export interface CustomGames {
    list(): Promise<StoredCustomGame[]>
    get(label: string): Promise<StoredCustomGame | null>
    /** Adds or replaces by label. */
    put(g: StoredCustomGame): Promise<void>
    remove(label: string): Promise<void>
  }
  export function createCustomGames(paths: AppPaths): CustomGames
  export const STEAM_PREFIX = 'steam-'
  export const CUSTOM_PREFIX = 'custom-'
  ```
  - `BEPINEX_INSTALL_RULES` is the standard BepInEx rule set, identical to the catalog's for `repo`: routes `BepInEx/plugins` (`.dll`, `subdir`, default location), `BepInEx/core` (`subdir`), `BepInEx/patchers` (`subdir`), `BepInEx/monomod` (`.mm.dll`, `subdir`), `BepInEx/config` (`none`), all with empty `subRoutes`.
  - `folderLabel`: lowercase, runs of non-`[a-z0-9]` become `-`, trim `-`, cut to 48 chars, empty → `game`; prefix `custom-`; if taken, append `-2`, `-3`, ….
  - `customGameDef`: `label`, `displayName`, `steamAppId`, `steamFolderName: ''`, `exeNames: exeName ? [exeName] : []`, `dataFolderName`, `loader: loaderChoice === 'none' ? 'deploy' : 'bepinex'`, `installRules: loaderChoice === 'none' ? [] : BEPINEX_INSTALL_RULES`, `packageIndex: null`, `searchStrings: [displayName]`, `iconUrl: steamAppId ? \`https://cdn.cloudflare.steamstatic.com/steam/apps/${steamAppId}/library_600x900.jpg\` : null`, `supported: true`, `custom: { source, loaderChoice, runner: runner ?? null, added: true }`.
  - The store file is a JSON array; `list()` drops malformed entries (wrong types, unknown `loaderChoice`, labels not starting with `steam-`/`custom-`). Writes go through a module-local promise chain like `nexus/games.ts`'s `locked`.
- Modifies `nexus/games.ts`: `isDeploy` becomes "is a Nexus-only game": `g.label.startsWith(DEPLOY_PREFIX)`. Rename it `isNexusOnly`. A custom no-loader game (loader `deploy`, label `steam-…`) then uses overrides/name lookup like catalog games.

- [ ] **Step 1: Write the failing tests:**
  - `customGames.test.ts`:
    - `folderLabel slugs the folder name and avoids taken labels` — `folderLabel('Trash Day!', new Set())` → `'custom-trash-day'`; with `taken` containing it → `'custom-trash-day-2'`; `folderLabel('???', new Set())` → `'custom-game'`.
    - `customGameDef maps a BepInEx Steam game` — `{ label:'steam-3314580', source:'steam', displayName:'Trash Day', steamAppId:'3314580', loaderChoice:'bepinex5', exeName:'Trash.exe', dataFolderName:'Trash_Data' }` → `loader: 'bepinex'`, `installRules: BEPINEX_INSTALL_RULES`, `exeNames: ['Trash.exe']`, `packageIndex: null`, `custom: { source:'steam', loaderChoice:'bepinex5', runner:null, added:true }`.
    - `customGameDef maps a no-loader game to deploy` — `loaderChoice:'none'` → `loader: 'deploy'`, `installRules: []`.
    - `put, get, list and remove round-trip through custom-games.json`.
    - `list drops malformed entries` — write `[{label:'x'}, {…valid…}, {…valid but loaderChoice:'melon'}]` → only the valid one.
  - `games.test.ts`: `a custom no-loader game is not treated as Nexus-only` — `cachedDomain({ ...def, label: 'steam-3314580', loader: 'deploy' }, settingsWith({ nexusDomainOverrides: { 'steam-3314580': 'trashday' } }))` → `'trashday'` (before the fix it returns `'3314580'`).
- [ ] **Step 2: Run** both test files — expect FAIL.
- [ ] **Step 3: Implement** `customGames.ts` and the `nexus/games.ts` change.
- [ ] **Step 4: Run** both test files plus `tests/main/nexus` — expect PASS.
- [ ] **Step 5: Commit**: `feat(custom): store custom games and tell them apart from Nexus-only games`.

---

### Task 5: Release tracks and loader specs

**Files:**
- Create: `src/main/custom/loaders.ts`
- Modify: `src/main/github/api.ts` (`fetchRelease`), `src/main/github/service.ts` (`lookup`, `memoLookup`, `install`, `checkUpdates`, `update`, `autoUpdateProfile`, `GhInstallOptions`)
- Test: `tests/main/custom/loaders.test.ts`, `tests/main/github/api.test.ts` (add cases), `tests/main/services.test.ts` (add GitHub cases)

**Interfaces:**
- Produces in `loaders.ts`:
  ```ts
  export interface LoaderSpec {
    choice: Exclude<LoaderChoice, 'none'>
    owner: 'BepInEx'
    repo: 'BepInEx'
    assetPattern: string
    track: GhTrack
    /** Short name for buttons: "BepInEx 5 (Mono)". */
    label: string
  }
  export const LOADER_SPECS: Record<Exclude<LoaderChoice, 'none'>, LoaderSpec>
  export function loaderSpec(choice: LoaderChoice): LoaderSpec | null
  /** The loader GitHub mod in a profile (BepInEx/BepInEx, case-insensitive), if any. */
  export function findLoaderMod(mods: InstalledMod[]): InstalledMod | undefined
  /** True when the installed loader mod is the build `spec` describes. */
  export function loaderMatches(mod: InstalledMod, spec: LoaderSpec): boolean
  ```
  Values (from BepInEx's real release assets):
  - `bepinex5`: `assetPattern: 'BepInEx_win_x64_{version}.zip'`, `track: { major: 5, prerelease: false }`, `label: 'BepInEx 5 (Mono)'`
  - `bepinex6-mono`: `'BepInEx-Unity.Mono-win-x64-{version}.zip'`, `{ major: 6, prerelease: true }`, `'BepInEx 6 (Mono)'`
  - `bepinex6-il2cpp`: `'BepInEx-Unity.IL2CPP-win-x64-{version}.zip'`, `{ major: 6, prerelease: true }`, `'BepInEx 6 (IL2CPP)'`
  - `loaderMatches`: `mod.github?.track?.major === spec.track.major && mod.github?.assetPattern === spec.assetPattern`.
- Produces in `api.ts`: `fetchRelease` accepts `track?: GhTrack`. With a track (and no `tag`) it reads `${base}/releases?per_page=30` and returns the first non-draft release whose tag's major version (first number after an optional `v`) equals `track.major` and which is not a pre-release unless `track.prerelease`; none → `Error("<owner>/<repo> has no <major>.x release.")`. Without a track, behavior is unchanged.
- Produces in `service.ts`:
  - `GhInstallOptions` gains `track?: GhTrack` and `assetPattern?: string`. When `assetPattern` is given, the asset is the single release asset matching it (`matchesAssetPattern`); none → `Error("<owner>/<repo> <tag> has no file like <assetPattern>.")` before anything is installed (Review Focus 4). The saved `GhModConfig` is `{ updateMode: 'auto', assetPattern, track }`.
  - `memoLookup` returns `(owner: string, repo: string, track?: GhTrack) => Promise<GhRelease>`, memo key includes the track (`owner/repo#5/false`). `checkUpdates`, `update` and `autoUpdateProfile` pass `configOf(m).track`.
  - `updateMod`/`installChosen` keep `track` in the config they carry over (`keep` already copies the whole config; confirm the track survives an update).

- [ ] **Step 1: Write the failing tests:**
  - `loaders.test.ts`:
    - `asset patterns match BepInEx's real release files` — `matchesAssetPattern(LOADER_SPECS.bepinex5.assetPattern, 'BepInEx_win_x64_5.4.23.5.zip')` true and `'BepInEx_win_x86_5.4.23.5.zip'` false; `bepinex6-mono` matches `'BepInEx-Unity.Mono-win-x64-6.0.0-pre.2.zip'` and not `'BepInEx-Unity.Mono-linux-x64-6.0.0-pre.2.zip'`; `bepinex6-il2cpp` matches `'BepInEx-Unity.IL2CPP-win-x64-6.0.0-pre.2.zip'`.
    - `loaderSpec('none') is null`.
    - `findLoaderMod finds the BepInEx/BepInEx GitHub mod case-insensitively` and `loaderMatches compares track and asset pattern`.
  - `api.test.ts` (fake fetch returning a release list like the real one: `v5.4.23.5` stable, `v6.0.0-pre.2` pre-release, `v5.4.23.4` stable):
    - `a 5.x stable track picks the newest 5.x release` → `v5.4.23.5`.
    - `a 6.x pre-release track picks the newest 6.x release` → `v6.0.0-pre.2`.
    - `a 6.x stable-only track with only pre-releases throws` → `'BepInEx/BepInEx has no 6.x release.'`.
  - `services.test.ts`:
    - `ghCheckUpdates respects a saved release track` — a profile with a `BepInEx/BepInEx` GitHub mod at `v5.4.23.4` whose config has `track: { major: 5, prerelease: false }`; the release list has `v6.0.0` (stable) and `v5.4.23.5` → one update with `latest: 'v5.4.23.5'`.
    - Installing with `assetPattern`/`track` is tested through `installLoader` in Task 9 (including Review Focus 4).
- [ ] **Step 2: Run** the three test files — expect FAIL.
- [ ] **Step 3: Implement** `loaders.ts`, the `fetchRelease` track option and the service changes.
- [ ] **Step 4: Run** the three files plus `tests/main/github` — expect PASS.
- [ ] **Step 5: Commit**: `feat(github): release tracks for loader mods; BepInEx loader specs`.

---

### Task 6: Launch plans: inert doorstop ini, direct launches, runners

**Files:**
- Create: `src/main/launch/runners.ts`
- Modify: `src/main/launch/launchPlan.ts`, `src/main/launch/launcher.ts`
- Test: `tests/main/launch/launchPlan.test.ts`, `tests/main/launch/launcher.test.ts` (add cases), `tests/main/launch/runners.test.ts`

**Interfaces:**
- Produces in `launchPlan.ts`:
  - `LaunchPlan` gains `env?: Record<string, string>`, `cwd?: string`, and `what: string` (for the error message: `'Steam'`, `'the game'`, `'Proton'`, `'Wine'`). `buildLaunchPlan` sets `what: 'Steam'`.
  - `export function doorstopArgs(i: { mode: LaunchMode; doorstop: DoorstopVersion; profileDir: string; preloaderRelPath: string; windowsPaths: 'native' | 'proton'; platform: 'win32' | 'linux' }): string[]` — extracted from `buildLaunchPlan` (vanilla → `[enableFlag, 'false']`; modded → enable/target and the IL2CPP corlib flags). `buildLaunchPlan` uses it; its output is unchanged.
  - `export function buildSteamPlainPlan(i: { platform; steamRoot; steamAppId; flatpak }): LaunchPlan` — `-applaunch <id>` with no doorstop args, `copyToGameDir: []` (no-loader Steam games).
  - `export interface DirectLaunchInput { platform: 'win32' | 'linux'; mode: LaunchMode; gameDir: string; exeName: string; runner: Runner | null; prefixDir: string; steamRoot: string | null; loader: { profileDir: string; preloaderRelPath: string; doorstop: DoorstopVersion } | null }`
  - `export function buildDirectLaunchPlan(i: DirectLaunchInput): LaunchPlan`:
    - exe path `join(gameDir, exeName)`; `cwd: gameDir`; doorstop args from `doorstopArgs` when `loader` is set (`windowsPaths: 'proton'` on Linux), none when `loader` is null; `copyToGameDir` = the doorstop files when `loader` is set and mode is modded, else `[]`.
    - Windows: `command` = exe path, `args` = doorstop args, `what: 'the game'`.
    - Linux + Proton: `command = join(runner.path, 'proton')`, `args = ['run', exePath, ...doorstop]`, `env = { STEAM_COMPAT_DATA_PATH: prefixDir, STEAM_COMPAT_CLIENT_INSTALL_PATH: steamRoot ?? '', WINEDLLOVERRIDES: 'winhttp=n,b' }`, `what: 'Proton'`.
    - Linux + Wine: `command = 'wine'`, `args = [exePath, ...doorstop]`, `env = { WINEDLLOVERRIDES: 'winhttp=n,b' }` (the user's default Wine prefix), `what: 'Wine'`.
    - Linux with `runner: null` throws `Error('Choose how to run this game (Proton or Wine) from the game menu.')`.
- Produces in `launcher.ts`:
  - `export function disableDoorstopIni(text: string): string` — replaces the value of every line whose key is exactly `enabled` (`/^(\s*enabled\s*=\s*)true\b/gim`) with `false`; nothing else changes.
  - `launch()` writes `doorstop_config.ini` into the game folder as `disableDoorstopIni(<profile's ini>)` instead of a byte copy (other doorstop files are still copied); spawns with `{ detached: true, stdio: 'ignore', shell: false, cwd: plan.cwd, env: plan.env ? { ...process.env, ...plan.env } : undefined }`; creates `plan.env.STEAM_COMPAT_DATA_PATH` with `mkdir -p` when set; its spawn error reads `Could not start ${plan.what}: <msg>`.
  - This satisfies spec goal 8: the launch arguments enable doorstop for HML's modded launch; a plain Steam launch reads `enabled=false`.
- Produces in `runners.ts`:
  ```ts
  /** Proton builds in the libraries' steamapps/common (names starting "Proton") and in <steamRoot>/compatibilitytools.d, each a folder with a `proton` file; newest first. */
  export async function findProtonVersions(steamRoot: string | null, libraries: string[]): Promise<Extract<Runner, { kind: 'proton' }>[]>
  export async function wineAvailable(execFile: ExecFilePort): Promise<boolean>
  export function defaultRunner(protons: Runner[], wine: boolean): Runner | null
  ```
  Newest first: compare the numbers in the folder names as version parts (`GE-Proton9-20` → `[9,20]`, `Proton 8.0` → `[8,0]`), higher first; names with no number (`Proton - Experimental`) sort after numbered ones; ties by name. `wineAvailable` is true when `execFile('wine', ['--version'])` resolves. `defaultRunner` → first Proton, else `{ kind: 'wine' }` when available, else null.

- [ ] **Step 1: Write the failing tests:**
  - `launchPlan.test.ts`:
    - `buildLaunchPlan output is unchanged after extracting doorstopArgs` — keep every existing test green (no edits to their expectations except adding `what: 'Steam'` where whole plans are compared).
    - `buildSteamPlainPlan launches the app with no doorstop arguments` → linux non-flatpak: `{ command: 'steam', args: ['-applaunch', '3314580'], copyToGameDir: [], what: 'Steam' }`.
    - `direct Windows launch runs the exe with doorstop arguments` — `gameDir 'C:\\Games\\X'`, `exeName 'X.exe'`, modded, doorstop 4, preloader `BepInEx/core/BepInEx.Preloader.dll`, profileDir `'C:\\hml\\p'` → `command: 'C:\\Games\\X\\X.exe'`, args `['--doorstop-enabled','true','--doorstop-target-assembly','C:\\hml\\p\\BepInEx\\core\\BepInEx.Preloader.dll']`, `cwd: 'C:\\Games\\X'`, `copyToGameDir: ['winhttp.dll','doorstop_config.ini','.doorstop_version']`.
    - `direct Proton launch uses proton run with an HML prefix and winhttp override` — runner `{kind:'proton', name:'Proton 9.0', path:'/s/steamapps/common/Proton 9.0'}` → `command: '/s/steamapps/common/Proton 9.0/proton'`, `args[0..1] = ['run', '/g/X.exe']`, doorstop target `Z:\\h\\p\\BepInEx\\core\\BepInEx.Preloader.dll`, env as specified.
    - `direct Wine launch sets only the winhttp override` → `command: 'wine'`, `env: { WINEDLLOVERRIDES: 'winhttp=n,b' }`.
    - `a vanilla direct launch disables doorstop and copies nothing` → args end with `['--doorstop-enable','false']` (doorstop 3), `copyToGameDir: []`.
    - `a no-loader direct launch has no doorstop arguments` — `loader: null` → Wine args `['/g/X.exe']`.
    - `direct launch on Linux without a runner throws`.
  - `launcher.test.ts`:
    - `disableDoorstopIni turns off doorstop 3 and 4 configs only` (Review Focus 3) — v3 text `"[UnityDoorstop]\nenabled=true\ntargetAssembly=BepInEx\\core\\BepInEx.Preloader.dll\n"` → `enabled=false`, target unchanged; v4 text `"[General]\nenabled = true\ntarget_assembly = x\n[UnityMono]\ndebug_enabled = true\n"` → `enabled = false`, `debug_enabled = true` unchanged.
    - `launch writes a disabled doorstop ini into the game folder` — profile ini `[General]\nenabled = true`, after `launch(plan, …)` the game folder's ini contains `enabled = false` and `winhttp.dll` is copied byte-for-byte.
    - `launch passes cwd and merged env to spawn` — assert the options object the fake spawn receives.
    - Update the existing `'Could not start Steam: spawn steam ENOENT'` expectation only if `what` changes it (it shouldn't).
  - `runners.test.ts` (fake folders in `mkdtemp`):
    - `finds Proton builds in libraries and compatibilitytools.d, newest first` — `Proton 8.0/proton`, `Proton 9.0/proton`, `Proton - Experimental/proton`, `compatibilitytools.d/GE-Proton9-20/proton`, and `Proton 7.0/` without a `proton` file → names `['GE-Proton9-20', 'Proton 9.0', 'Proton 8.0', 'Proton - Experimental']`.
    - `defaultRunner prefers Proton, then Wine, then null`.
    - `wineAvailable reflects execFile` — resolving fake → true; rejecting → false.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=2 tests/main/launch` — expect FAIL.
- [ ] **Step 3: Implement** per the interfaces.
- [ ] **Step 4: Run** `tests/main/launch` — expect PASS.
- [ ] **Step 5: Commit**: `feat(launch): direct and plain launches, runners, and an inert doorstop ini in the game folder`.

---

### Task 7: Manual install detection and backup

**Files:**
- Create: `src/main/custom/manualInstall.ts`
- Test: `tests/main/custom/manualInstall.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const MANUAL_LOADER_ENTRIES = ['BepInEx', 'winhttp.dll', 'doorstop_config.ini', '.doorstop_version', 'changelog.txt']
  /** The entries present in gameDir when a `BepInEx` folder is there (case-insensitive names, returned as on disk); null when there is no BepInEx folder. */
  export async function findManualLoader(gameDir: string): Promise<string[] | null>
  /** Moves `entries` from gameDir into backupDir (created), copying then deleting so it works across filesystems; returns backupDir. */
  export async function moveToBackup(gameDir: string, entries: string[], backupDir: string): Promise<string>
  export function backupStamp(now: Date): string   // 'YYYY-MM-DD-HHmmss', local time
  ```
  - HML itself only ever puts the doorstop files in the game folder, so a `BepInEx` folder means a hand install. Doorstop files alone are not a manual install.
  - `moveToBackup` refuses entries that aren't in `MANUAL_LOADER_ENTRIES` (compared case-insensitively) or contain path separators. It copies each entry with `fs.cp(src, dest, { recursive: true, errorOnExist: true, force: false })`, and only after every copy succeeded removes the originals; if any copy fails it removes the partial backup and rethrows, leaving the game folder untouched.

- [ ] **Step 1: Write the failing tests:**
  - `finds a hand-installed BepInEx and its doorstop files` — game dir with `BepInEx/plugins/a.dll`, `winhttp.dll`, `doorstop_config.ini`, `changelog.txt`, `Trash.exe` → `['BepInEx','changelog.txt','doorstop_config.ini','winhttp.dll']` (sorted).
  - `doorstop files without a BepInEx folder are not a manual install` → null.
  - `moveToBackup moves everything and keeps the files` — afterwards the game dir has only `Trash.exe`; `backupDir/BepInEx/plugins/a.dll` exists with the same content.
  - `moveToBackup works when rename would cross devices` (Review Focus 1) — `vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }))` and the move still succeeds (proves no reliance on rename).
  - `moveToBackup leaves the game folder untouched when a copy fails` — make `fs.cp` reject on the second entry → original entries all still present; backupDir removed.
  - `moveToBackup refuses entries outside the manual-loader list` — `['Trash_Data']` → throws, nothing moved.
  - `backupStamp formats local time` — `new Date(2026, 9, 16, 9, 5, 7)` → `'2026-10-16-090507'`.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=2 tests/main/custom/manualInstall.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** per the interface.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit**: `feat(custom): find and back up a hand-installed BepInEx`.

---

### Task 8: Custom game services: catalog, search, add/remove/edit

**Files:**
- Create: `src/main/custom/service.ts`
- Modify: `src/main/services.ts` (`getCatalog`, `summarize`/`deployFolder`, `searchGames`, `nxSetDomain`, wiring), `src/shared/ipc.ts` (methods + `METHOD_TABLE`)
- Test: `tests/main/custom/service.test.ts` (build `deps` like `tests/main/services.test.ts:80-117`, with a fake Steam root containing an installed non-catalog app `3314580` "Trash Day" laid out as in Task 3), `tests/shared/ipc.test.ts` if it lists methods

**Interfaces:**
- Consumes: Tasks 1–4, 7; `listLibraries`, `findAppInstall`; `loadSettings`/`updateSettings`; `deployedProfileId` from `deploy.ts`.
- Produces `HmlApi` methods (add to `src/shared/ipc.ts` with doc comments, and to `METHOD_TABLE`):
  ```ts
  export type AddCustomGameInput =
    | { source: 'steam'; steamAppId: string; loaderChoice: LoaderChoice; displayName?: string }
    | { source: 'folder'; folder: string; displayName: string; loaderChoice: LoaderChoice; runner?: Runner | null }
  export interface CustomGameUpdate { displayName?: string; loaderChoice?: LoaderChoice; runner?: Runner | null }

  /** Detection for an installed Steam game (by `steam-<appid>` label) or an added custom game. */
  detectCustomGame(label: string): Promise<{ displayName: string; folder: string; detection: GameDetection }>
  /** Folder dialog, then detection; null when cancelled. */
  pickCustomGameFolder(): Promise<{ folder: string; displayName: string; detection: GameDetection } | null>
  addCustomGame(input: AddCustomGameInput): Promise<GameSummary>
  updateCustomGame(label: string, patch: CustomGameUpdate): Promise<GameSummary>
  removeCustomGame(label: string): Promise<void>
  listRunners(): Promise<Runner[]>
  ```
  - Put `AddCustomGameInput` and `CustomGameUpdate` in `src/shared/types.ts`.
  - `createCustomGameServices(ctx: { deps: ServiceDeps; customGames: CustomGames; getCatalog(): Promise<Catalog>; getBaseCatalog(): Promise<Catalog>; getSteamRoot(): Promise<string | null>; summarize(def: GameDef): Promise<GameSummary>; nexus: NexusGames })` returns those six methods plus `steamCandidates(query: string, catalog: Catalog): Promise<GameSummary[]>` for `searchGames`.
- Behavior:
  - `getCatalog()` appends `customGames.list().map(customGameDef)` after Nexus-added games (skip labels already present).
  - `steamCandidates(query)`: empty/1-char query → `[]`; otherwise installed apps (Task 2) whose name contains the query (case-insensitive), excluding apps whose id is any catalog game's `steamAppId` (anti-goal) and already-added `steam-<id>` labels; each becomes a `GameSummary` with label `steam-<id>`, `displayName` = manifest name, `steamAppId`, `installDir`, `loader: 'deploy'`, `installRules: []`, `packageIndex: null`, `searchStrings: []`, Steam capsule `iconUrl` as in Task 4, `supported: true`, `loaderPackageIds: []`, `custom: { source: 'steam', loaderChoice: 'none', added: false }`.
  - `searchGames` returns `[...catalog results (unchanged ranking), ...steamCandidates, ...nexus extras]` (spec goal 1 order). A failing Steam scan yields no candidates, never an error.
  - `deployFolder` (services.ts) for a deploy game with a `steamAppId` falls back to `findAppInstall` when there's no override (custom Steam no-loader games); Nexus-only games are unaffected (no app id).
  - `addCustomGame` (steam): requires the app to be installed (`findAppInstall`), else `Error("<name or appid> isn't installed through Steam.")`; runs `detectGameFolder` for `exeName`/`dataFolderName`; refuses a BepInEx choice when `detection.nativeLinux` with `Error("BepInEx needs the Windows version of <name>. Force Proton in the game's Steam properties, then add it again.")`; stores `{ label: 'steam-<id>', … }` (re-adding the same id replaces the entry, so its existing profiles reappear).
  - `addCustomGame` (folder): folder must be a directory; label via `folderLabel(basename(folder), <existing labels>)` unless a stored folder game already has `gamePathOverrides[label] === folder` (re-add reuses its label); writes `gamePathOverrides[label] = folder` through `updateSettings`; `runner` defaults to `defaultRunner(...)` on Linux and `null` on Windows; `displayName` trimmed, empty → `basename(folder)`.
  - `updateCustomGame`: unknown label → `Error('Unknown game: <label>')`; validates `loaderChoice` against the four values; `displayName` trimmed non-empty; changing `loaderChoice` changes only what new profiles get (no profile is touched).
  - `removeCustomGame`: refuses with `Error('Remove the deployed mods from the game folder first.')` when `deployedProfileId(paths, def)` is non-null (Review Focus 5); otherwise removes the entry and, in one `updateSettings`, deletes the label from `gamePathOverrides`, `nexusDomainOverrides`, `lastProfile`, `manualLoaderKept`, and clears `lastGame` if equal; calls `nexus.forgetDomain(label)`; profiles on disk stay.
  - `nxSetDomain`'s refusal applies only to Nexus-only games (`label.startsWith('nexus-')`), not to every deploy game.
  - `listRunners()` → on Windows `[]`; on Linux `[...findProtonVersions(steamRoot, libraries), ...(wineAvailable ? [{kind:'wine'}] : [])]`.

- [ ] **Step 1: Write the failing tests** in `tests/main/custom/service.test.ts` (through `createServices(deps)`):
  - `searching "trash" lists the installed Steam game under its own label, after catalog games` — `searchGames('trash')` includes `{ label: 'steam-3314580', displayName: 'Trash Day', custom: { added: false } }` with `installDir` set; catalog matches come first.
  - `an installed game that is a catalog game is not listed twice` — the fake Steam also has the catalog game's app id; its candidate is absent.
  - `an empty query lists added custom games but no un-added Steam games`.
  - `adding a Steam game stores it with the detected exe and the chosen loader` — `addCustomGame({ source:'steam', steamAppId:'3314580', loaderChoice:'bepinex5' })` → summary `loader: 'bepinex'`, `exeNames: ['Trash.exe']`, `custom.added: true`; `getGame('steam-3314580')` returns it.
  - `adding BepInEx to a native Linux build is refused` — fake game folder without `.exe` → rejects with the message above.
  - `adding a folder game saves its folder and a runner` — `platform: 'linux'`, a Proton folder in the fake library → summary `installDir` = folder, `custom.runner.kind === 'proton'`; `getSettings().gamePathOverrides['custom-…']` = folder.
  - `re-adding a removed Steam game picks its profiles back up` — add, `createProfile`, remove, add → `listProfiles('steam-3314580')` still has the profile.
  - `removing a custom game clears its settings` — set path override, Nexus override, lastProfile, `manualLoaderKept` → all cleared; profile folder still exists.
  - `removing a deployed no-loader game is refused` (Review Focus 5) — add with `loaderChoice:'none'`, deploy a profile → `removeCustomGame` rejects with `'Remove the deployed mods from the game folder first.'`.
  - `updateCustomGame renames and changes the loader for new profiles only` — rename to `'Trash Day (dev)'`; switch to `'bepinex6-mono'`; existing profile's mods unchanged.
  - `a custom no-loader game can have a Nexus domain override` — `nxSetDomain('steam-3314580', …)` doesn't throw the Nexus-only refusal (fake `gameByDomain` fetch).
  - `listRunners lists Proton builds and Wine on Linux` — fake `execFile` resolves for `wine`.
  - `tests/shared/ipc.test.ts`: the new method names are in `HML_METHODS` (if that test enumerates them).
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=2 tests/main/custom/service.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `src/main/custom/service.ts` and the `services.ts`/`ipc.ts` changes; spread the custom services into `createServices`' return object.
- [ ] **Step 4: Run** `tests/main/custom tests/main/services.test.ts tests/shared` — expect PASS; `npm run typecheck`.
- [ ] **Step 5: Commit**: `feat(custom): add, edit, remove and search custom games`.

---

### Task 9: Loader install, warnings, launch and manual-install services

**Files:**
- Modify: `src/main/custom/service.ts`, `src/main/services.ts` (`createProfile`, `getLaunchWarnings`, `launch`), `src/main/launch/launcher.ts` (`launchWarnings` input), `src/shared/ipc.ts`
- Test: `tests/main/custom/service.test.ts` (add cases)

**Interfaces:**
- Consumes: Task 5 (`LOADER_SPECS`, `findLoaderMod`, `loaderMatches`, `GhInstallOptions.track/assetPattern`), Task 6 (`buildDirectLaunchPlan`, `buildSteamPlainPlan`, `defaultRunner`), Task 7, Task 8.
- Produces `HmlApi` methods:
  ```ts
  /** Installs (or switches to) the game's chosen BepInEx in the profile from BepInEx's GitHub releases. */
  installLoader(game: string, profileId: string): Promise<InstalledMod>
  /** A hand-installed BepInEx in the game folder; null when there is none. */
  getManualLoader(game: string): Promise<{ entries: string[]; kept: boolean } | null>
  /** Moves it to HML's backup folder; returns that folder. */
  removeManualLoader(game: string): Promise<string>
  /** Remembers "Keep" for this game. */
  keepManualLoader(game: string): Promise<void>
  ```
- Behavior:
  - `installLoader`: game must be a custom game with a BepInEx choice, else `Error('<name> doesn't use BepInEx.')`. `assertGameClosed(def)` first. If the profile has a loader mod (`findLoaderMod`) that doesn't `loaderMatches` the spec, uninstall it (`uninstallMod`, under the profile lock, released before installing). Then install via the internal GitHub install (`ghInstallWith(game, profileId, 'https://github.com/BepInEx/BepInEx', undefined, { track: spec.track, assetPattern: spec.assetPattern })`), which records it as a raw loader (`provides` the loader id) through the existing raw-BepInEx path. Returns the installed mod. If the matching loader is already installed, return it without reinstalling.
  - `createProfile` (services.ts): after `createProfile(paths, game, name)`, for a custom game with a BepInEx choice, try `installLoader`; on failure keep the profile and `deps.emit({ type: 'progress', message: "Couldn't install BepInEx: <msg>", done: 1, total: 1 })` — the profile then shows the `no-bepinex` warning with its one-click action (Task 11). The share import keeps calling the raw `createProfile(paths, …)` (no auto-install; the shared profile carries its own loader mod).
  - `getLaunchWarnings` for custom games:
    - BepInEx custom game whose profile has a loader mod that doesn't match the spec → add `'loader-mismatch'`.
    - Folder games: no `steam-not-found`/`proton-launch-options`/`flatpak-filesystem`; on Linux a null runner → `'no-runner'`; `game-not-found` when the folder is gone; `no-bepinex` as for Steam games; `native-linux-unsupported` doesn't apply when a runner is set (the runner runs the `.exe`).
    - Custom no-loader Steam games: only `game-not-found` (as deploy games today).
  - `launch`:
    - Custom Steam BepInEx games: the existing Steam path (no change needed beyond `def.loader === 'bepinex'`).
    - Custom no-loader Steam games: `buildSteamPlainPlan` for either mode (modded and vanilla differ only in what is deployed).
    - Folder games: `exeName` required (`Error("HML couldn't tell which program starts <name>. Remove the game and add it again.")`); `buildDirectLaunchPlan` with `prefixDir: paths.winePrefix(label)`, `runner: def.custom.runner`, `loader` set for BepInEx choices (preloader from `findPreloader` or the default, doorstop from `detectDoorstopVersion` as today) and null for no-loader games.
    - Catalog and Nexus-only games: unchanged.
  - `getManualLoader`: only for games with `loader === 'bepinex'` and a resolvable game folder; `kept` from `settings.manualLoaderKept`.
  - `removeManualLoader`: `assertGameClosed(def)`; `findManualLoader` → none → `Error('There is no manual BepInEx install in the game folder.')`; `moveToBackup(gameDir, entries, paths.loaderBackup(label, backupStamp(new Date(now()))))`; removes the label from `manualLoaderKept`; returns the backup path.
  - `keepManualLoader`: adds the label to `manualLoaderKept` (no duplicates).

- [ ] **Step 1: Write the failing tests** (fake `fetch` serving the BepInEx release list from Task 5 and zip bodies built with `fflate.zipSync` containing `BepInEx/core/BepInEx.Preloader.dll`, `winhttp.dll`, `doorstop_config.ini`):
  - `creating a profile for a BepInEx custom game installs BepInEx 5 from GitHub` — profile has one mod with `source.owner === 'BepInEx'`, `source.asset === 'BepInEx_win_x64_5.4.23.5.zip'`, `github.track` `{major:5, prerelease:false}`, and `BepInEx/core/BepInEx.Preloader.dll` in the profile folder.
  - `a failed loader download still creates the profile and reports it` — fetch rejects for the zip → profile exists, `emitted` has a progress message starting `"Couldn't install BepInEx"`, `getLaunchWarnings` includes `'no-bepinex'`.
  - `installLoader switches a profile to the newly chosen loader` — add as `bepinex5`, create profile, `updateCustomGame(…, { loaderChoice: 'bepinex6-mono' })` → `getLaunchWarnings` includes `'loader-mismatch'`; `installLoader` → one loader mod, asset `BepInEx-Unity.Mono-win-x64-6.0.0-pre.2.zip`; warning gone.
  - `installLoader with no matching release file changes nothing` (Review Focus 4) — release list whose 5.x release has only `BepInEx_linux_x64_5.4.23.5.zip` → rejects with `'BepInEx/BepInEx v5.4.23.5 has no file like BepInEx_win_x64_{version}.zip.'`; profile mods unchanged.
  - `modded launch of a custom Steam game uses Steam with doorstop arguments` — `spawned[0].args` contains `-applaunch`, `3314580`, `--doorstop-enable`, `true`.
  - `a no-loader Steam game launches through Steam without doorstop arguments`.
  - `a folder game on Linux launches through its Proton runner` — `spawned[0].cmd` ends with `/proton`, args start with `['run', <folder>/Trash.exe]`.
  - `a folder game on Linux without a runner warns and refuses to launch` — `'no-runner'` warning; `launch` rejects with the Task 6 message.
  - `getManualLoader finds a hand install and remembers Keep` — game folder with `BepInEx/`; `kept` false → `keepManualLoader` → `kept` true.
  - `removeManualLoader backs up the hand install and clears Keep` — returns a path under `<root>/backups/steam-3314580/`; game folder no longer has `BepInEx/`.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=2 tests/main/custom/service.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Pass `ghInstallWith` into `createCustomGameServices`' ctx (it already exists in `services.ts`).
- [ ] **Step 4: Run** `npx vitest run --maxWorkers=2 tests/main` — expect PASS; `npm run typecheck`.
- [ ] **Step 5: Commit**: `feat(custom): loader install and switch, launches, warnings and manual-install cleanup`.

---

### Task 10: Share codes for custom games

**Files:**
- Modify: `src/main/share/hmlFile.ts` (`exportSchema`, `buildHmlFile`), `src/main/share/service.ts` (`build`, `previewShare`, `importShare`, `resolveGame`), `src/shared/ipc.ts` (`importShare` signature)
- Test: `tests/share/hmlFile.test.ts`, `tests/main/custom/service.test.ts` (share cases)

**Interfaces:**
- Produces:
  - `exportSchema` gains `customGame: z.object({ source: z.enum(['steam','folder']), displayName: z.string(), steamAppId: z.string().nullable(), loaderChoice: z.enum(['bepinex5','bepinex6-mono','bepinex6-il2cpp','none']) }).optional()` (non-strict object, so older HML versions ignore the key).
  - `buildHmlFile(profile, dir, extra?: { customGame?: HmlCustomGame })` writes it into `export.json`. The share service's `build` passes it for custom games (from the stored entry).
  - `importShare(token: string, name: string, folder?: string): Promise<ImportResult>`.
  - The share ctx gains `addCustomGame: HmlApi['addCustomGame']` and `findCustomGameByName(displayName: string): Promise<GameDef | undefined>` (case-insensitive match among stored folder games).
- Behavior (spec goal 7 and the folder-import designer call):
  - Preview of an export whose `game` is unknown here but has `customGame`:
    - `source: 'steam'`: if the app is installed here → preview normally, `gameName` = `customGame.displayName`; not installed → `Error("This profile is for <displayName>, which isn't installed through Steam on this PC.")`.
    - `source: 'folder'`: a stored folder game with the same display name → preview normally (import uses that game); none → preview with `needsFolder: true`.
  - Import: Steam → `addCustomGame({ source:'steam', steamAppId, loaderChoice })` then proceed; folder with a name match → that game's label; folder without a match → `folder` required (`Error('Choose the game folder to import this profile.')`), then `addCustomGame({ source:'folder', folder, displayName, loaderChoice })`.
  - An export of a known label (same machine, or the game already added) imports as today.

- [ ] **Step 1: Write the failing tests:**
  - `hmlFile.test.ts`: `customGame round-trips through an .hml file`; `an .hml file without customGame still reads`.
  - `service.test.ts`:
    - `sharing a custom Steam game records it, and importing on a fresh install adds it` — export from one services instance; second instance with a fresh data dir and the same fake Steam → `previewShare({file:true})` (dialog returns the saved file) → `importShare` → `getGame('steam-3314580')` exists with `custom.loaderChoice` from the export.
    - `importing a Steam custom game that isn't installed is refused` — second instance's Steam lacks the app → preview rejects with the message above.
    - `importing a folder game asks for its folder unless a game with that name exists` — preview `needsFolder: true`; `importShare(token, '')` rejects with `'Choose the game folder to import this profile.'`; `importShare(token, '', folder)` creates `custom-…` and the profile.
- [ ] **Step 2: Run** `tests/share/hmlFile.test.ts tests/main/custom/service.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `tests/share tests/main` — expect PASS.
- [ ] **Step 5: Commit**: `feat(share): share and import profiles for custom games`.

---

### Task 11: Renderer: game picker, add dialog and store

**Files:**
- Create: `src/renderer/src/customView.ts`, `src/renderer/src/components/AddGameDialog.tsx`
- Modify: `src/renderer/src/store.ts`, `src/renderer/src/components/GamePicker.tsx`
- Test: `tests/renderer/customView.test.ts`, `tests/renderer/store.test.ts` (add cases)

**Interfaces:**
- Produces in `customView.ts`:
  ```ts
  export const isNexusOnly: (g: GameDef) => boolean          // label starts with 'nexus-'
  export const isSteamCandidate: (g: GameDef) => boolean     // g.custom?.added === false
  /** "Unity (Mono) — BepInEx 5, recommended" for the suggested choice; plain labels otherwise. */
  export function loaderOptionLabel(choice: LoaderChoice, detection: GameDetection): string
  export function loaderChoicesFor(detection: GameDetection): LoaderChoice[]  // nativeLinux → ['none']
  export function runnerLabel(r: Runner): string                              // proton → r.name, wine → 'Wine'
  ```
  `loaderOptionLabel` copy: `bepinex5` → `Unity (Mono) — BepInEx 5`; `bepinex6-mono` → `Unity (Mono) — BepInEx 6 (pre-release)`; `bepinex6-il2cpp` → `Unity (IL2CPP) — BepInEx 6 (GitHub pre-release)` (the spec's IL2CPP designer call: the label says it uses the GitHub pre-release); `none` → `No loader (copy mods into the game folder)`; the suggested choice gets `, recommended` appended.
- Produces in the store: `addCustomGame(input: AddCustomGameInput): Promise<void>` (adds then `selectGame`), `manualLoader: { game: string; entries: string[] } | null`, `resolveManualLoader(action: 'remove' | 'keep'): Promise<void>`. `selectGame` calls `api.getManualLoader` for `loader === 'bepinex'` games after profiles load and sets `manualLoader` when non-null and not kept. `remove` toasts `Moved the manual BepInEx install to <path>`.
- Replace `loader === 'deploy'` checks that mean "Nexus-only" with `isNexusOnly`: `GamePicker.tsx:13`, `ProfileSidebar.tsx:62` (Task 12 edits that file; do this one there). Leave checks that mean "uses deployment" as they are.
- GamePicker:
  - Groups: catalog/added games, then `Installed on Steam` (candidates), then `From Nexus Mods`. Same heading style as the Nexus group.
  - Header gets a `Add a game by folder…` button → `api.pickCustomGameFolder()` → AddGameDialog (folder mode).
  - Choosing a candidate → `api.detectCustomGame(label)` → AddGameDialog (Steam mode). A candidate card has an `On Steam` badge and no `Set folder…` link.
  - Empty-result copy becomes: `No games match “<query>”. Installed Steam games show up here too; for anything else use Add a game by folder….`
- AddGameDialog (follow the existing dialog components in `ui.tsx`/`ShareDialog.tsx`): name field (folder mode, and edit mode), loader radio list from `loaderChoicesFor` with `loaderOptionLabel`, native-Linux note with the Global Constraints copy, runner select on Linux in folder mode (`api.listRunners()`; empty → note `Install Proton through Steam or Wine to run this game.`), confirm button `Add game` (edit mode: `Save`). Props: `{ mode: 'steam' | 'folder' | 'edit'; game?: GameSummary; detection: GameDetection; folder?: string; initialName: string; onClose(): void }`.

- [ ] **Step 1: Write the failing tests:**
  - `customView.test.ts`: `loaderOptionLabel marks the suggested choice` → `loaderOptionLabel('bepinex5', monoDetection) === 'Unity (Mono) — BepInEx 5, recommended'`; `loaderChoicesFor offers only No loader for native Linux builds`; `isNexusOnly uses the label, not the loader` (`{label:'steam-1', loader:'deploy'}` → false); `runnerLabel`.
  - `store.test.ts` (existing pattern with a fake `window.hml`): `selecting a BepInEx game with a hand install opens the prompt` → `manualLoader` set; `kept: true` → stays null; `resolveManualLoader('keep') calls keepManualLoader and clears the prompt`.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=2 tests/renderer` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `tests/renderer` — PASS; `npm run typecheck && npm run lint`.
- [ ] **Step 5: Commit**: `feat(renderer): installed Steam games and folder games in the game picker`.

---

### Task 12: Renderer: game menu, launch bar, manual-install prompt, sources

**Files:**
- Create: `src/renderer/src/components/ManualLoaderDialog.tsx`
- Modify: `src/renderer/src/components/ProfileSidebar.tsx`, `LaunchBar.tsx`, `ModList.tsx`, `Browse.tsx`, `ImportDialog.tsx`, `App.tsx` (mount the prompt), `src/renderer/src/store.ts`, `src/renderer/src/customView.ts`
- Test: `tests/renderer/customView.test.ts` (add cases)

**Interfaces:**
- Produces in `customView.ts`: `export function sourcesFor(game: GameSummary, nexusDomain: string | null): { online: ('thunderstore' | 'nexus')[]; githubPrimary: boolean }` — `online` has `thunderstore` when `packageIndex` is set and `nexus` when `nexusDomain` is non-null (Nexus-only games always have one); `githubPrimary` when `online` is empty.
- Store: `currentDomain: string | null`, loaded with `api.nxGetDomain` in `selectGame` (errors → null) and refreshed after a domain change; `installLoader(): Promise<void>` (busy, then refresh profile and warnings, toast `Installed <mod name> <version>`); `updateCustomGame(patch)`, `removeCustomGame()` (confirm in the component, then `leaveGame()` and toast `Removed <name> from HML. Its profiles are kept.`).
- ProfileSidebar menu: for non-Nexus-only games keep `Nexus domain…`; for custom games add `Rename…`, `Change loader…` (AddGameDialog edit mode with `api.detectCustomGame`), `Change runner…` (Linux folder games; same dialog), `Remove manual BepInEx install…` (shown when `api.getManualLoader` returns non-null; runs `removeManualLoader` after a confirm), `Remove from HML…` (confirm text `Remove <name> from HML? Its profiles stay on disk and come back if you add the game again.`).
- LaunchBar: the `no-bepinex` warning for a custom BepInEx game gets an `Install BepInEx` button (`installLoader`); `loader-mismatch` reads `This profile has <installed loader label>; <game> is set to <chosen label>.` with a `Switch to <chosen label>` button (`installLoader`); `no-runner` gets a `Choose runner…` button opening the edit dialog. Deploy games with a launch (custom Steam no-loader, and custom folder no-loader) show a `Play` button (`launch('vanilla')`) beside Deploy/Remove; folder BepInEx games use the normal modded/vanilla buttons. `store.launch` stops returning early for deploy games that are custom.
- ModList/Browse: the Online tab shows only when `sourcesFor(...).online` is non-empty, and Browse's source switch lists only those sources. When `githubPrimary`, `Add from GitHub` is `variant="primary"` and listed first in the header and the empty state, and `Install from file` is `variant="quiet"`; otherwise `Install from file` drops from primary to the default variant in the empty state (spec goal 5: zip is the fallback). Empty-state copy for custom games: `No mods in this profile yet. Add a mod from its GitHub repository, or drop a .zip here.`
- ImportDialog: when the preview has `needsFolder`, show `This profile is for <gameName>, which HML doesn't know yet. Choose its folder to add it.` with a `Choose folder…` button (`api.pickCustomGameFolder`, keeping only `folder`), and pass the folder to `importShare`.
- ManualLoaderDialog: the exact prompt and buttons from Global Constraints, listing `entries`; `Remove` → `resolveManualLoader('remove')`, `Keep` → `resolveManualLoader('keep')`.

- [ ] **Step 1: Write the failing tests** in `customView.test.ts`:
  - `a custom game with no Nexus domain makes GitHub the primary source` → `sourcesFor({...custom, packageIndex:null}, null)` → `{ online: [], githubPrimary: true }`.
  - `a catalog game offers Thunderstore and, with a domain, Nexus` → `{ online: ['thunderstore','nexus'], githubPrimary: false }`.
  - `a custom game with a Nexus domain offers Nexus only`.
- [ ] **Step 2: Run** `tests/renderer/customView.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run --maxWorkers=2` (full suite), `npm run typecheck`, `npm run lint` — all PASS.
- [ ] **Step 5: Commit**: `feat(renderer): custom game menu, loader actions, manual-install prompt and per-game sources`.

---

### Task 13: Hand check in the running app

**Files:** none (verification only; fix anything found in the owning task's files and commit with a `fix(...)` message).

- [ ] **Step 1:** `npm run build` — expect success. Start the app with the remote debugging port used before (`/tmp/hml-cdp` helpers, port 9333) and pass `--user-data-dir=<a new temp dir>` so HML uses a throwaway data dir (Electron's `userData` follows that switch) and the user's real settings and profiles are untouched.
- [ ] **Step 2:** Search `trash` → `Trash Day` appears under `Installed on Steam`. Open it → the dialog suggests `Unity (Mono) — BepInEx 5, recommended`. Add it → the Default profile gets BepInEx 5 from GitHub (needs network; no token required).
- [ ] **Step 3:** The manual-install prompt appears (Trash Day's folder has a hand-installed BepInEx). **Do not press Remove** — it would move the user's files. Press Keep, and stop here for the controller to ask the user whether to try Remove and a modded launch on their real Trash Day folder.
- [ ] **Step 4:** Paste a GitHub mod URL from the user's own repos only if the user names one; otherwise skip. Report screenshots of the picker, add dialog and launch bar.
