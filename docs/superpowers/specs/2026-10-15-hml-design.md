# HML Design Spec

HML (Haro's Mod Loader): an Electron + React + Tailwind mod manager modeled on r2modman. Per-game profiles, Thunderstore and Nexus Mods search/install, GitHub-release installs with auto-update, and hosted profile share codes.

## Decisions (from the 2026-10-15 kickoff)

### Games: agnostic, searchable catalog
- No hardcoded game list. The catalog is built from **Thunderstore's ecosystem schema** (`https://thunderstore.io/api/experimental/schema/dev/latest/`, schemaVersion 0.3.0, ~357 games). Each `games[label].r2modman[0]` entry provides `meta.displayName`, `distributions` (platform + Steam app id), `steamFolderName`, `exeNames`, `dataFolderName`, `packageLoader`, `installRules`, and `packageIndex`. Top-level `modloaderPackages` lists loader packages (`bbepis-BepInExPack`, `rootFolder: "BepInExPack"`, …).
- The schema is cached on disk; the cached copy is used when offline. A bundled snapshot ships with the app for first run offline.
- Nexus-only games are added to search results from the Nexus v2 GraphQL `games` query (no API key needed) and use a generic "deploy" loader (plan 4).
- Loaders are strategies behind one interface. `bepinex` ships first (plan 1). Other loaders in the schema (`melonloader`, `recursive-melonloader`, `shimloader`, …) appear in search but show "loader not yet supported" until their strategy lands.

### Profiles and launching
- Profiles live under HML's data dir: `<userData>/games/<gameLabel>/profiles/<profileId>/`, mirroring r2modman. The profile dir is the BepInEx root (`BepInEx/plugins`, `BepInEx/config`, …) and holds `hml-profile.json`.
- BepInEx games launch through Steam with doorstop args that point at the profile, so the game folder only receives `winhttp.dll` + `doorstop_config.ini` (+ `.doorstop_version` if present). Vanilla launch passes the doorstop-disabled flag.
- Linux/Proton: target paths are passed as `Z:\…`; HML reads the game's Steam `LaunchOptions` and warns with a copyable fix if `WINEDLLOVERRIDES="winhttp=n,b" %command%` is missing.
- Enable/disable renames tracked files to `<file>.old` (r2modman behavior).

### Thunderstore (plan 2)
- Package list per community comes from the `packageIndex` URL: a gzipped JSON array of chunk URLs, and each chunk is a gzipped JSON array of packages. HML caches the list and searches it locally. Installs resolve `Author-Name-Version` dependencies. Updates are checked against the cached list.

### GitHub (plan 3)
- Accepts `github.com/<owner>/<repo>` or release URLs. Uses `/releases/latest`, falling back to the newest release in `/releases`.
- Asset choice: ignore source-code archives → prefer a `.zip` containing `manifest.json` → the only `.zip` → a lone `.dll` asset → otherwise ask the user and save the choice as a filename pattern, with version-like segments generalized.
- Zips go through the same install planner as Thunderstore packages (package id `<owner>-<repo>`).
- Checks for updates on startup and every 6 hours using ETag conditional requests. An optional personal access token is stored with `safeStorage`. Per-mod setting: auto-install (default) / notify only / pinned.
- Each GitHub mod records owner, repo, tag, asset name and sha256.

### Nexus Mods (plan 4)
- Login: the user pastes a personal API key, stored with `safeStorage` and validated with `/v1/users/validate.json`. Search and metadata come from the v2 GraphQL API.
- Downloads: premium accounts call `download_link.json` directly. Free accounts download through an `nxm://` protocol handler that HML registers ("Mod Manager Download" on the site), which supplies `key` + `expires`.

### Share codes (plan 5)
- Hosted on a small **Cloudflare Worker + KV** that HML owns: `POST /v1/profiles` (body: `.hml` zip, max 10 MB, rate limited per IP) returns `{ code }`, and `GET /v1/profiles/:code` returns the zip. Codes are 10 characters of Crockford base32.
- The `.hml` file is a zip containing `export.json` plus the profile's `BepInEx/config/**`. `export.json` holds `{ formatVersion: 1, game, profileName, mods: [{ source, version, enabled }] }`, where `source` is the `ModSource` union below.
- Import resolves each mod to its exact version and lists unresolved entries (deleted release, Nexus premium needed) instead of failing silently.

### Mod identity (shared by all sources)
```ts
type ModSource =
  | { kind: 'thunderstore'; fullName: string }               // "Author-Name"
  | { kind: 'github'; owner: string; repo: string; tag: string; asset: string; sha256: string }
  | { kind: 'nexus'; domain: string; modId: number; fileId: number }
  | { kind: 'local'; fileName: string; sha256: string };
```

## Defaults chosen (the user can override)
- Platforms: Windows + Linux. macOS is not targeted.
- GitHub mods auto-install updates by default.
- r2modman code/`.r2z` import: after v1.

## Plan sequence
1. Foundation: scaffold, catalog, Steam detection, profiles, install engine, BepInEx launch, base UI. *(docs/superpowers/plans/2026-10-15-hml-foundation.md)*
2. Thunderstore browse/install/dependencies/updates
3. GitHub installs + auto-update
4. Nexus login/search/download + Nexus-only games (deploy loader)
5. Share codes: `.hml` export/import + Cloudflare Worker
