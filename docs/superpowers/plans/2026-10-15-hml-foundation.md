# HML Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runnable Electron app where you search any Thunderstore-schema game, create profiles, install a local mod zip (including BepInExPack) into a profile, enable/disable/uninstall it, and launch the game modded or vanilla through Steam on Windows and Linux/Proton.

**Architecture:** electron-vite with three parts: `src/main` (all filesystem, network and process work), `src/preload` (exposes a typed `HmlApi` via `contextBridge`), and `src/renderer` (React UI, no Node access). Core logic sits in pure functions (VDF parsing, schema parsing, install planning, launch planning), each unit-tested. Thin executors apply their results to disk.

**Tech Stack:** Electron, electron-vite, React 19, TypeScript (strict), Tailwind CSS v4 (`@tailwindcss/vite`), zod, fflate (zip), zustand, electron-builder, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-15-hml-design.md`

## Global Constraints

- Vitest always runs with `--maxWorkers=2` (set `maxWorkers: 2` in `vitest.config.ts` and pass the flag in scripts).
- The renderer never imports Node modules. Every privileged action goes through `HmlApi` (`src/shared/ipc.ts`).
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` for the main window.
- Platforms: Windows + Linux only. Linux Steam can be native or Flatpak.
- Data root is `app.getPath('userData')`, injected as a path so tests use a temp dir.
- Every JSON write goes to a temp file first and is then renamed into place (`writeJsonAtomic`).
- Catalog source: `https://thunderstore.io/api/experimental/schema/dev/latest/`.

## Review Focus

1. **Malicious zip entries** (`../x.dll`, `/etc/x`, `C:\x`) must be rejected and nothing written. Owner: Task 7 test `rejects path traversal`.
2. **Mod zips wrapped in one top folder** (`MyMod-1.2.0/manifest.json`, typical of GitHub zips) must install as if unwrapped, unless that folder is itself a route (`BepInEx/`, `plugins/`). Owner: Task 7 tests `strips single wrapper folder` / `does not strip route folder`.
3. **Games in a secondary Steam library or Flatpak Steam** must still be detected. Owner: Task 3 tests `finds app in second library` / `detects flatpak root`.
4. **Profile paths with spaces/non-ASCII under Proton** must become a correct `Z:\…` path and stay a single argument. Owner: Task 9 test `proton target path with spaces`.
5. **Offline startup** must load the catalog from cache (or the bundled snapshot) and still open the app. Owner: Task 4 test `falls back to cache when fetch fails`.

---

## File Structure

```
electron.vite.config.ts, vitest.config.ts, electron-builder.yml, tsconfig*.json
resources/ecosystem-snapshot.json           bundled schema for offline first run
src/shared/types.ts                         GameDef, InstallRule, ProfileManifest, InstalledMod, ModSource, LaunchMode
src/shared/ipc.ts                           HmlApi interface + channel name helper
src/main/index.ts                           app/window bootstrap
src/main/ipc.ts                             registers HmlApi handlers
src/main/store/paths.ts                     AppPaths (data layout)
src/main/store/json.ts                      readJson / writeJsonAtomic
src/main/store/settings.ts                  Settings load/save
src/main/steam/vdf.ts                       KeyValues text parser
src/main/steam/steam.ts                     Steam roots, libraries, app install dir, launch options
src/main/catalog/ecosystem.ts               parse schema → GameDef[], searchGames
src/main/catalog/catalog.ts                 fetch + cache + fallback
src/main/profiles/profiles.ts               profile CRUD
src/main/install/planInstall.ts             pure: zip entries → destination paths
src/main/install/installer.ts               apply plan, uninstall, enable/disable
src/main/launch/launchPlan.ts               pure: build Steam command + doorstop args + files to copy
src/main/launch/launcher.ts                 detect doorstop/proton, copy files, spawn
src/preload/index.ts                        exposes window.hml
src/renderer/…                              React UI (Task 11)
tests/** mirror src/main/**                 fixtures in tests/fixtures/
```

---

### Task 1: Scaffold and typed IPC skeleton

**Files:**
- Create: the electron-vite React-TS project at the repo root, `vitest.config.ts`, `electron-builder.yml`, `src/shared/ipc.ts`, `src/shared/types.ts` (empty exports for now), `tests/shared/ipc.test.ts`
- Modify: `.gitignore` (add `out/`, `dist/`, `node_modules/`), `README.md`

**Interfaces:**
- Produces: `channel(method: keyof HmlApi): string` returns `` `hml:${method}` ``. `HmlApi` starts with `ping(): Promise<'pong'>`. `window.hml: HmlApi` is typed in `src/renderer/src/env.d.ts`.

- [ ] **Step 1:** Scaffold into a temp dir (the generator is interactive and creates a subfolder): `npm create @quick-start/electron@latest /tmp/hml-scaffold -- --template react-ts`. Copy its contents into the repo root without overwriting `README.md`, `CLAUDE.md`, `.gitignore` or `docs/`. Then `npm install`.
- [ ] **Step 2:** Add Tailwind v4: `npm i -D tailwindcss @tailwindcss/vite`, add the plugin to the renderer section of `electron.vite.config.ts`, and put `@import "tailwindcss";` in the renderer's main CSS file. Add `npm i zod fflate zustand` and `npm i -D vitest`.
- [ ] **Step 3:** Create `vitest.config.ts` with `test: { environment: 'node', include: ['tests/**/*.test.ts'], maxWorkers: 2 }`. Add the script `"test": "vitest run --maxWorkers=2"`.
- [ ] **Step 4: Write the failing test** `tests/shared/ipc.test.ts`:
```ts
import { channel } from '../../src/shared/ipc';
test('channel names are namespaced', () => { expect(channel('ping')).toBe('hml:ping'); });
```
- [ ] **Step 5:** Run `npm test` and confirm it fails because `channel` is not exported.
- [ ] **Step 6:** Implement `HmlApi`, `channel`, a `ping` handler in `src/main/ipc.ts` (`registerIpc(api: HmlApi)` loops over the api's keys and calls `ipcMain.handle(channel(k), (_e, ...a) => api[k](...a))`), and the preload proxy (`contextBridge.exposeInMainWorld('hml', …)` built from a hardcoded list of method names `HML_METHODS: (keyof HmlApi)[]` exported from `src/shared/ipc.ts`). Window options follow Global Constraints. Show `ping` result in the default App as a smoke check.
- [ ] **Step 7:** Run `npm test` (PASS) and `npm run build` (exit 0), then `npm run dev`. The window opens and shows "pong".
- [ ] **Step 8:** Commit `chore: scaffold electron-vite + react + tailwind with typed IPC`.

### Task 2: VDF parser

**Files:** Create `src/main/steam/vdf.ts`, `tests/main/steam/vdf.test.ts`

**Interfaces:**
- Produces: `type VdfObject = { [key: string]: string | VdfObject }`. `parseVdf(text: string): VdfObject`. `vdfGet(obj: VdfObject, ...path: string[]): string | VdfObject | undefined` matches keys case-insensitively.

- [ ] **Step 1: Write failing tests:** `parses nested objects` (the `libraryfolders` sample below), `handles escaped quotes and backslashes` (`"path" "C:\\\\Steam \\"x\\""` → `C:\Steam "x"`), `ignores // comments`, `vdfGet is case-insensitive` (`vdfGet(o,'LibraryFolders','0','PATH')`).
```
"libraryfolders"
{
	"0" { "path" "/home/u/.local/share/Steam" "apps" { "3241660" "123" } }
	"1" { "path" "/mnt/games/SteamLibrary" }
}
```
- [ ] **Step 2:** Run `npx vitest run tests/main/steam/vdf.test.ts --maxWorkers=2` and confirm FAIL.
- [ ] **Step 3:** Implement a tokenizer for quoted strings, unquoted tokens, `{`, `}` and comments, plus a recursive-descent parser. Duplicate keys: the last one wins.
- [ ] **Step 4:** Run the tests and confirm PASS.
- [ ] **Step 5:** Commit `feat(steam): VDF parser`.

### Task 3: Steam locator

**Files:** Create `src/main/steam/steam.ts`, `tests/main/steam/steam.test.ts`, fixtures built in a temp dir inside the tests

**Interfaces:**
- Consumes: `parseVdf`, `vdfGet` (Task 2).
- Produces:
  - `steamRootCandidates(platform: NodeJS.Platform, home: string, winSteamPath?: string): string[]`. On Linux, in order: `~/.steam/steam`, `~/.local/share/Steam`, `~/.var/app/com.valvesoftware.Steam/.local/share/Steam`. On Windows: `winSteamPath` (from the registry, `HKCU\Software\Valve\Steam\SteamPath`, read in the executor with `reg query`) then `C:\Program Files (x86)\Steam`.
  - `findSteamRoot(candidates: string[]): Promise<string | null>` returns the first candidate containing `steamapps/libraryfolders.vdf`, after realpath. Symlinked duplicates collapse to one.
  - `isFlatpakSteam(root: string): boolean` is true when the path contains `/.var/app/com.valvesoftware.Steam/`.
  - `listLibraries(root: string): Promise<string[]>`
  - `findAppInstall(root: string, appId: string): Promise<string | null>` checks each library for `steamapps/appmanifest_<appId>.acf` and returns `<lib>/steamapps/common/<installdir>`.
  - `readLaunchOptions(root: string, appId: string): Promise<string | null>` reads each `userdata/*/config/localconfig.vdf` at `UserLocalConfigStore/Software/Valve/Steam/apps/<appId>/LaunchOptions` and returns the first non-empty value.

- [ ] **Step 1: Write failing tests:** `finds app in second library` (library 1 holds `appmanifest_3241660.acf` with `"installdir" "REPO"` → `/…/lib1/steamapps/common/REPO`), `returns null when app missing`, `detects flatpak root`, `linux candidate order`, `reads launch options case-insensitively`.
- [ ] **Step 2:** Run and confirm FAIL.
- [ ] **Step 3:** Implement with `fs/promises`.
- [ ] **Step 4:** Run and confirm PASS.
- [ ] **Step 5:** Commit `feat(steam): locate steam libraries, game installs, launch options`.

### Task 4: Game catalog

**Files:** Create `src/main/catalog/ecosystem.ts`, `src/main/catalog/catalog.ts`, `src/main/store/json.ts`, `src/main/store/paths.ts`, `resources/ecosystem-snapshot.json`, `tests/fixtures/ecosystem-min.json` (the real `repo` game, one `melonloader` game, `modloaderPackages`), `tests/main/catalog/*.test.ts`. Add `GameDef`, `InstallRule` and `ModloaderPackage` to `src/shared/types.ts`.

**Interfaces:**
- Produces:
```ts
interface InstallRule { route: string; defaultFileExtensions: string[]; trackingMethod: 'subdir' | 'none' | 'state' | 'package-zip' | string; subRoutes: InstallRule[]; isDefaultLocation: boolean }
interface GameDef { label: string; displayName: string; steamAppId: string | null; steamFolderName: string;
  exeNames: string[]; dataFolderName: string; loader: string; installRules: InstallRule[];
  packageIndex: string | null; searchStrings: string[]; iconUrl: string | null; supported: boolean }
interface ModloaderPackage { packageId: string; rootFolder: string; loader: string }
interface Catalog { games: GameDef[]; modloaderPackages: ModloaderPackage[]; fetchedAt: string }
```
  - `parseEcosystem(json: unknown): Catalog`. Uses `r2modman[0]`, skips games without one, and only reads `steamAppId` from a `platform: 'steam'` distribution. `supported = loader === 'bepinex'`. `iconUrl` is prefixed with `https://thunderstore.io/static/` only if it isn't already absolute (verify the exact static prefix against a live icon during implementation). Validate with zod (lenient: `.passthrough()`).
  - `searchGames(games: GameDef[], query: string): GameDef[]` does a case-insensitive substring match on displayName, label and searchStrings. Empty query returns all games. Ranking: exact match, then prefix match, then substring match, alphabetical within each group.
  - `AppPaths` (`paths.ts`): `makePaths(root: string)` returns `{ root, settings, schemaCache, downloads, gameDir(label), profilesDir(label), profileDir(label,id) }`, using `cache/ecosystem.json` and `cache/downloads/`.
  - `readJson<T>(file: string): Promise<T | null>`, `writeJsonAtomic(file: string, data: unknown): Promise<void>`.
  - `loadCatalog(paths: AppPaths, fetchFn: typeof fetch, snapshotPath: string, maxAgeMs = 86_400_000): Promise<Catalog>` uses the cache if it's fresh. Otherwise it fetches and writes the cache. If the fetch fails it falls back to the stale cache, then the snapshot.

- [ ] **Step 1: Write failing tests:** `parses repo game` (`steamAppId '3241660'`, `exeNames ['REPO.exe']`, `loader 'bepinex'`, `supported true`, 5 installRules), `melonloader game unsupported`, `search ranks exact before substring`, `search matches additionalSearchStrings`, `uses fresh cache without fetching`, `falls back to cache when fetch fails` (fetchFn rejects and the stale cache is returned), `falls back to snapshot with no cache`, `writeJsonAtomic leaves no temp file`.
- [ ] **Step 2:** Run and confirm FAIL.
- [ ] **Step 3:** Implement. Save the snapshot with `curl -sL <schema url> -o resources/ecosystem-snapshot.json` and list it under `extraResources` in `electron-builder.yml`.
- [ ] **Step 4:** Run and confirm PASS.
- [ ] **Step 5:** Commit `feat(catalog): data-driven game catalog from Thunderstore ecosystem schema`.

### Task 5: Settings

**Files:** Create `src/main/store/settings.ts`, `tests/main/store/settings.test.ts`

**Interfaces:**
- Produces: `interface Settings { gamePathOverrides: Record<string, string>; steamRootOverride: string | null; lastGame: string | null; lastProfile: Record<string, string> }`. `loadSettings(paths): Promise<Settings>` merges stored values over defaults. `saveSettings(paths, s): Promise<void>`. `resolveGameDir(game: GameDef, settings: Settings, steamRoot: string | null): Promise<string | null>`: the override first, then `findAppInstall` when `steamAppId` is set.

- [ ] **Step 1: Write failing tests:** `defaults when file missing`, `round-trips`, `override beats steam detection`.
- [ ] **Step 2:** Run and confirm FAIL. **Step 3:** Implement. **Step 4:** Run and confirm PASS.
- [ ] **Step 5:** Commit `feat(store): settings and game dir resolution`.

### Task 6: Profiles

**Files:** Create `src/main/profiles/profiles.ts`, `tests/main/profiles/profiles.test.ts`. Add `ProfileManifest`, `InstalledMod` and `ModSource` (exactly as in the spec) to `src/shared/types.ts`.

**Interfaces:**
- Produces:
```ts
interface InstalledMod { id: string; name: string; version: string; source: ModSource; enabled: boolean;
  files: string[]; disableable: string[]; installedAt: string }   // paths relative to profile dir, posix separators
interface ProfileManifest { formatVersion: 1; id: string; name: string; game: string; createdAt: string; mods: InstalledMod[] }
```
  - `slugifyProfileName(name: string): string`: lowercase, strips characters invalid on Windows (`<>:"/\|?*`), converts whitespace runs to `-`, rejects reserved names (`con`, `nul`, …) by appending `-1`. An empty result becomes `profile`.
  - `createProfile(paths, game, name): Promise<ProfileManifest>` adds a `-2`, `-3`, … suffix when the id already exists.
  - `listProfiles(paths, game): Promise<ProfileManifest[]>`
  - `getProfile(paths, game, id): Promise<ProfileManifest>`
  - `saveProfile(paths, m): Promise<void>`
  - `renameProfile(paths, game, id, name)` changes `name` only; the id stays fixed.
  - `deleteProfile(paths, game, id)`

- [ ] **Step 1: Write failing tests:** `creates dir and manifest`, `duplicate names get suffixed ids` (`Default`, `Default` → `default`, `default-2`), `slug strips illegal chars` (`'My: Pack?'` → `my-pack`), `reserved name` (`'CON'` → `con-1`), `rename keeps id`, `delete removes dir`, `list skips dirs without manifest`.
- [ ] **Step 2:** Run and confirm FAIL. **Step 3:** Implement. **Step 4:** Run and confirm PASS.
- [ ] **Step 5:** Commit `feat(profiles): profile CRUD`.

### Task 7: Install planner (pure)

**Files:** Create `src/main/install/planInstall.ts`, `tests/main/install/planInstall.test.ts`

**Interfaces:**
- Consumes: `InstallRule`, `ModloaderPackage` (Task 4).
- Produces:
```ts
interface PlannedFile { from: string; to: string; disableable: boolean }   // from = zip entry, to = profile-relative
interface InstallPlan { files: PlannedFile[] }
class UnsafeEntryError extends Error {}
function planInstall(entries: string[], opts: { packageId: string; rules: InstallRule[]; loaderPackage?: ModloaderPackage }): InstallPlan
```
`entries` lists file paths only (directory entries filtered out by the caller), using `/` separators.

Algorithm (r2modman's legacy installer, BepInEx subset):
1. **Safety:** normalize `\` to `/`. Throw `UnsafeEntryError` for any entry that is absolute (`/x`, `C:/x`) or contains a `..` segment.
2. **Wrapper strip:** if every entry shares one top-level folder `W`, and `W` (case-insensitive) is not `bepinex` and not the last segment of any rule's route, strip `W/`. Repeat while this still applies.
3. **Loader package:** if `loaderPackage` is set, map `<rootFolder>/<rest>` to `<rest>` (with `disableable: false`) and drop all other entries. Done.
4. Strip a leading `BepInEx/` (case-insensitive) from the working path.
5. **Folder match:** if the first segment equals (case-insensitive) the last segment of a rule's `route`, the destination is `route/<packageId>/<rest>` for `subdir` rules or `route/<rest>` for `none` rules.
6. **Extension match (root files only):** pick the rule with the longest `defaultFileExtensions` entry the filename ends with. Destination: `route/<packageId>/<file>`.
7. **Otherwise:** `<defaultRoute>/<packageId>/<path>`, where the default route is the rule with `isDefaultLocation`.
8. `disableable = (rule.trackingMethod !== 'none')`.

- [ ] **Step 1: Write failing tests** using the REPO rules from the fixture, `packageId 'Author-Mod'`:
```ts
expect(plan(['manifest.json','icon.png','README.md','Mod.dll'])).toEqual([
  { from:'manifest.json', to:'BepInEx/plugins/Author-Mod/manifest.json', disableable:true }, … ,
  { from:'Mod.dll', to:'BepInEx/plugins/Author-Mod/Mod.dll', disableable:true }]);
```
  - `routes plugins/patchers/config folders`: `plugins/A.dll` → `BepInEx/plugins/Author-Mod/A.dll`; `patchers/P.dll` → `BepInEx/patchers/Author-Mod/P.dll`; `config/a.cfg` → `BepInEx/config/a.cfg` with `disableable:false`
  - `handles BepInEx/ prefix`: `BepInEx/plugins/A.dll` → `BepInEx/plugins/Author-Mod/A.dll`
  - `mm.dll goes to monomod`: `X.mm.dll` → `BepInEx/monomod/Author-Mod/X.mm.dll`
  - `strips single wrapper folder`: `MyMod-1.2.0/manifest.json`, `MyMod-1.2.0/Mod.dll` → same as unwrapped
  - `does not strip route folder`: `['config/a.cfg','config/b.cfg']` → `BepInEx/config/a.cfg`, `BepInEx/config/b.cfg` (stripping would wrongly send them to `BepInEx/plugins/Author-Mod/`); `['BepInEx/config/x.cfg']` → `BepInEx/config/x.cfg`
  - `loader package`: entries `BepInExPack/winhttp.dll`, `BepInExPack/BepInEx/core/BepInEx.Preloader.dll`, `icon.png` with `loaderPackage {rootFolder:'BepInExPack'}` → `winhttp.dll`, `BepInEx/core/BepInEx.Preloader.dll` (icon dropped)
  - `rejects path traversal`: `['../evil.dll']`, `['/abs.dll']`, `['C:/x.dll']`, `['a/../../b.dll']` each throw `UnsafeEntryError`
- [ ] **Step 2:** Run and confirm FAIL. **Step 3:** Implement. **Step 4:** Run and confirm PASS.
- [ ] **Step 5:** Commit `feat(install): legacy-compatible install planner`.

### Task 8: Installer executor and mod operations

**Files:** Create `src/main/install/installer.ts`, `tests/main/install/installer.test.ts` (test zips built with `fflate.zipSync`)

**Interfaces:**
- Consumes: `planInstall` (Task 7), `getProfile`/`saveProfile` (Task 6), `Catalog` (Task 4).
- Produces:
  - `readZipEntries(data: Uint8Array): { names: string[]; read(name: string): Uint8Array }` uses `fflate.unzipSync` and drops entries ending in `/`.
  - `detectPackageMeta(zip, fallbackName: string): { name: string; version: string } | null`. Reads `manifest.json` (at the root or under a single wrapper folder; it may have a UTF-8 BOM) and returns its `name` and `version_number`. Returns null when there's no manifest.
  - `installZip(paths, game: GameDef, catalog: Catalog, profileId: string, data: Uint8Array, source: ModSource, opts?: { packageId?: string; name?: string; version?: string }): Promise<InstalledMod>`
    - `packageId` = `opts.packageId` (later plans pass `Author-Name` / `owner-repo`), else the manifest `name`, else the zip filename without extension.
    - `version` = `opts.version`, else the manifest version, else `'0.0.0'`.
    - **Loader package detection:** a `modloaderPackages` entry with `loader === game.loader` applies when `packageId` equals its `packageId`, or (for local zips) when the manifest `name` equals the part of its `packageId` after the first `-` and the zip has entries under `<rootFolder>/`.
    - If the same `id` is already installed, uninstall it first (this is the upgrade path).
    - The id is `packageId`.
    - Writes the files and records `files` plus `disableable`.
  - `uninstallMod(paths, game, profileId, modId): Promise<void>` deletes the recorded files (and their `.old` variants), prunes empty dirs up to the profile root, and removes the mod from the manifest.
  - `setModEnabled(paths, game, profileId, modId, enabled: boolean): Promise<void>` renames each `disableable` file between `f` and `f.old`. It is idempotent: if the target name already exists, it skips that file.

- [ ] **Step 1: Write failing tests:**
  - `installs and records files`
  - `reinstall replaces old files`: version 1 had `Old.dll` and version 2 doesn't, so `Old.dll` is gone after the upgrade
  - `disable renames to .old, enable restores, config untouched`
  - `uninstall removes files and empty dirs but keeps other mods' files`
  - `installs BepInExPack to profile root`
  - `unsafe zip writes nothing`: the profile dir is unchanged and the promise rejects with `UnsafeEntryError`
  - `manifest with BOM parses`
- [ ] **Step 2:** Run and confirm FAIL. **Step 3:** Implement. **Step 4:** Run and confirm PASS.
- [ ] **Step 5:** Commit `feat(install): install, uninstall, enable/disable mods`.

### Task 9: Launch planning and launcher

**Files:** Create `src/main/launch/launchPlan.ts`, `src/main/launch/launcher.ts`, `tests/main/launch/launchPlan.test.ts`, `tests/main/launch/launcher.test.ts`

**Interfaces:**
- Consumes: `isFlatpakSteam`, `readLaunchOptions` (Task 3).
- Produces:
```ts
type LaunchMode = 'modded' | 'vanilla';
type DoorstopVersion = 3 | 4;
interface LaunchInput { platform: 'win32' | 'linux'; mode: LaunchMode; steamRoot: string; steamAppId: string;
  flatpak: boolean; proton: boolean; profileDir: string; preloaderRelPath: string; doorstop: DoorstopVersion }
interface LaunchPlan { command: string; args: string[]; copyToGameDir: string[] }   // copy paths are profile-relative
function toProtonPath(p: string): string                                            // '/home/u/a b' -> 'Z:\\home\\u\\a b'
function buildLaunchPlan(i: LaunchInput): LaunchPlan
```
- Command:
  - win32: `<steamRoot>\steam.exe`
  - linux flatpak: `flatpak` with leading args `['run', 'com.valvesoftware.Steam']`
  - linux native: `steam`
  - Then `-applaunch <appId>`.
- Doorstop args:
  - v4: `--doorstop-enabled <true|false> --doorstop-target-assembly <path>`
  - v3: `--doorstop-enable <true|false> --doorstop-target <path>`
  - `<path>` is the absolute path to `<profileDir>/<preloaderRelPath>` in native form, or `toProtonPath` form when `proton`. It is always one argv element and never shell-quoted (spawn with `shell: false`).
  - Vanilla mode passes only the enabled/enable flag set to `false`, and `copyToGameDir` is empty.
- Modded mode copies `['winhttp.dll', 'doorstop_config.ini', '.doorstop_version']`; the launcher filters out files that don't exist.
- `launcher.ts`:
  - `detectDoorstopVersion(profileDir): Promise<DoorstopVersion>`: 4 when `doorstop_config.ini` has a `[General]` section, else 3.
  - `findPreloader(profileDir): Promise<string | null>`: the first of `BepInEx/core/BepInEx.Preloader.dll`, `BepInEx/core/BepInEx.Unity.Mono.Preloader.dll`, `BepInEx/core/BepInEx.Unity.IL2CPP.dll` that exists.
  - `isProtonGame(platform, gameDir, exeNames): Promise<boolean>`: linux, and a `.exe` from `exeNames` exists in `gameDir`.
  - `launchWarnings(...)` returns string codes `'no-bepinex'` (no preloader in the profile), `'proton-launch-options'` (Proton game whose LaunchOptions don't include `winhttp=n,b`), `'game-not-found'` and `'loader-unsupported'`.
  - `launch(...)` copies the files, then calls `spawn(command, args, { detached: true, stdio: 'ignore' }).unref()`.

- [ ] **Step 1: Write failing tests:**
  - `windows v3 modded`
  - `linux native v4 modded`
  - `flatpak command`
  - `vanilla v4 disables and copies nothing`
  - `proton target path with spaces`: profile `/home/u/.config/HML/games/repo/profiles/my pack` → arg `Z:\home\u\.config\HML\games\repo\profiles\my pack\BepInEx\core\BepInEx.Preloader.dll` as a single element
  - `detects doorstop 4 from [General]`
  - `proton warning when launch options missing`
  - `no warning when present`
- [ ] **Step 2:** Run and confirm FAIL. **Step 3:** Implement. **Step 4:** Run and confirm PASS.
- [ ] **Step 5:** Commit `feat(launch): steam launch with doorstop redirection and proton support`.

### Task 10: Full IPC API wiring

**Files:** Modify `src/shared/ipc.ts`, `src/main/ipc.ts`, `src/main/index.ts`, `src/preload/index.ts`. Create `src/main/services.ts`, `tests/main/services.test.ts`

**Interfaces:**
- Produces (complete `HmlApi`; every method returns a Promise):
```ts
interface GameSummary extends GameDef { installDir: string | null }
interface HmlApi {
  searchGames(query: string): Promise<GameSummary[]>;          // installed games ranked first within each rank group
  refreshCatalog(): Promise<void>;
  setGamePath(label: string, dir: string | null): Promise<void>;
  pickGamePath(label: string): Promise<string | null>;          // folder dialog, then setGamePath
  listProfiles(game: string): Promise<ProfileManifest[]>;
  createProfile(game: string, name: string): Promise<ProfileManifest>;
  renameProfile(game: string, id: string, name: string): Promise<void>;
  deleteProfile(game: string, id: string): Promise<void>;
  installFromFile(game: string, profileId: string): Promise<InstalledMod[]>;  // multi-select .zip dialog; source kind 'local'
  setModEnabled(game: string, profileId: string, modId: string, enabled: boolean): Promise<void>;
  uninstallMod(game: string, profileId: string, modId: string): Promise<void>;
  getLaunchWarnings(game: string, profileId: string): Promise<string[]>;
  launch(game: string, profileId: string | null, mode: LaunchMode): Promise<void>;
  openProfileFolder(game: string, profileId: string): Promise<void>;
  getSettings(): Promise<Settings>;
  saveSettings(s: Settings): Promise<void>;
}
```
  - `createServices(deps: { paths: AppPaths; fetch: typeof fetch; snapshotPath: string; platform: NodeJS.Platform; home: string; dialog: DialogPort; shell: ShellPort; spawn: SpawnPort }): HmlApi` holds all the logic. `src/main/ipc.ts` only registers handlers. `DialogPort`, `ShellPort` and `SpawnPort` are small interfaces so tests can inject fakes.
  - Errors cross IPC as `Error` with `message` set to a user-readable string. The renderer shows the message.

- [ ] **Step 1: Write failing tests** with fake ports and a temp `paths`: `searchGames returns catalog games`, `installFromFile installs selected zip as local source with sha256`, `launch modded spawns steam with doorstop args`, `HML_METHODS covers every HmlApi key` (compares against `Object.keys(createServices(...))`).
- [ ] **Step 2:** Run and confirm FAIL. **Step 3:** Implement and remove `ping`. **Step 4:** Run `npm test` and `npm run typecheck`; both pass.
- [ ] **Step 5:** Commit `feat: wire HmlApi services over IPC`.

### Task 11: Base UI

**Files:** Create `src/renderer/src/{App.tsx, store.ts, api.ts}`, `src/renderer/src/components/{GamePicker,ProfileSidebar,ModList,LaunchBar,SettingsDialog,Toast}.tsx`

**Interfaces:**
- Consumes: `window.hml: HmlApi` (Task 10).
- Produces: the UI only. Later plans add `Browse (Thunderstore)`, `GitHub` and `Nexus` tabs next to `Installed` in the profile view.

Invoke the `frontend-design` skill before writing components, and preview the layout with `sai_render_html` for the user's sign-off before wiring it up. Layout follows r2modman:
- **GamePicker** (startup screen): a search box over `searchGames`, a grid of cover cards with "Installed" and "Not supported yet" badges, and a "Set folder…" action that calls `pickGamePath` when the install dir is null.
- **Main view:**
  - **Left sidebar:** profiles (create, rename, delete with confirmation), game switcher.
  - **Center:** the `Installed` tab, a ModList with an enable toggle, version, source badge and an uninstall menu, plus a drag-and-drop zone and an "Install from file" button.
  - **Top bar:** LaunchBar with "Start modded" and "Start vanilla", plus warning chips from `getLaunchWarnings`. `proton-launch-options` opens a dialog with a copy button for `WINEDLLOVERRIDES="winhttp=n,b" %command%`.
  - Settings dialog: Steam path override, game path override.
- zustand store holds `currentGame`, `currentProfile` and the persisted `lastGame` / `lastProfile` (through settings).

- [ ] **Step 1:** Run `frontend-design`, render the mockup with `sai_render_html` and get the user's approval.
- [ ] **Step 2:** Implement the components.
- [ ] **Step 3:** Run `npm run typecheck` and `npm run build`; both pass.
- [ ] **Step 4: Manual verification** (use the `run` skill to launch and screenshot):
  1. Search "repo" and select R.E.P.O.
  2. Create profile "Test Pack".
  3. Install `BBepInEx-BepInExPack` downloaded manually from Thunderstore, plus one plugin zip.
  4. Toggle the plugin off and check that its files end in `.old`.
  5. Start modded: on Linux, the warning chip appears if launch options are missing. With them set, the BepInEx console/log shows the plugin loaded.
  6. Start vanilla: no BepInEx log is produced.
  7. Restart the app: the last game and profile are restored.
- [ ] **Step 5:** Commit `feat(ui): game picker, profiles, mod list, launch bar`.
