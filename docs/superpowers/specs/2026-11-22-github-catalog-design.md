# GitHub catalog (third mod source)

## Intent

HML can already install a mod from a pasted GitHub repo URL and keep it updated (`src/main/github/`). But a user has to know the URL first. This feature adds a third browse source next to Thunderstore and Nexus Mods: an **open catalog of GitHub-hosted mods**. To be listed, any author adds a topic and a manifest file to their repo, with no sign-up or approval step. HML users can then browse and search the mods for their game, install one in a click, and get automatic updates through the GitHub install path HML already has.

Success: an author with a R.E.P.O. mod on GitHub adds the `hml-mod` topic and an `hml.json` to their repo, and publishes a release. Within an hour the mod shows up in HML's GitHub tab for R.E.P.O. A user finds it by searching, installs it, and gets every later release automatically. If the repo later turns out to be malicious, the HML maintainer adds it to a blocklist, and within the hour it disappears from every HML catalog and stops auto-updating for everyone who installed it.

## Goals

1. **Opt in with a topic and a manifest.** A repo is listed only if it has the GitHub topic `hml-mod` **and** a valid `hml.json` at the root of its default branch. The topic is how the repo gets found. The manifest is what gets listed. A tagged repo without a valid manifest is not listed, and the reason is recorded so the author can find out why (goal 7).
2. **A Worker-built index.** The existing Cloudflare Worker (`worker/`) crawls GitHub on a schedule. It validates manifests, reads the latest releases, applies the blocklist, and publishes one index per game. HML clients download that index. They never search GitHub to browse.
3. **A GitHub browse tab.** It sits beside the Thunderstore and Nexus browse views and offers search, a list, a detail view and install. The detail view shows the repo's README.
4. **Install and update through the existing GitHub path.** Installing from the catalog calls the existing `ghInstall` with the manifest's tag prefix and asset pattern. After that, the mod is an ordinary GitHub-source mod: same update modes, 6-hour checks, auto-update, share codes and sync. Downloads go straight from GitHub to the client. Nothing is proxied through the Worker.
5. **Context instead of approval.** Each listing shows the repo owner, stars, repo age, last release date and total downloads. The first install from a given repo owner shows a one-time confirmation that the mod comes from a GitHub author who isn't vetted by Thunderstore or Nexus. HML remembers each confirmed owner.
6. **Maintainer blocklist.** A blocklist stored in the Worker hides repos or whole owners from the index. Clients also fetch it to act on mods already installed from blocked repos (see Blocklist).
7. **Authors can see why they're not listed.**
   - The manifest format is published as a JSON Schema.
   - `hml validate` (CLI) checks a local `hml.json`, or asks the Worker for a repo's listing status and the reason for any rejection.
   - Author docs explain the topic, the manifest and the delay.

## Non-goals

- Hosting or mirroring mod files. The Worker stores only metadata.
- Approval queues, author accounts, ratings, comments or download-count tracking of our own.
- Sources other than GitHub (GitLab, Codeberg).
- Listing repos without a manifest, even if they have the topic.
- Real-time listing. Up to about an hour of delay is fine.

## Anti-goals (a failure even if it technically works)

- Users hitting GitHub rate limits just from browsing, or seeing a half-loaded catalog.
- An author's mod silently missing with no way to learn why.
- A repo on the blocklist still auto-updating on users' machines.
- A Worker that blows through the Cloudflare free tier (KV writes especially).

## Constraints

- The Worker is `hml-share` on the free plan: a 1,000-writes/day KV budget, cron triggers available, `workers.dev` domain. The Cache API does nothing on `workers.dev` (see `worker/README.md`).
- GitHub search: authenticated `/search/repositories` returns at most 1,000 results per query and allows 30 requests/min. The core API allows 5,000 requests/hour with a token. Conditional requests (ETag, 304 responses) don't count against the limit.
- Game identity: HML game labels. These are Thunderstore community slugs for ecosystem games (`repo`, `stonewards`). Nexus deploy games use `nexus-<domain>` (`DEPLOY_PREFIX` in `src/main/nexus/games.ts`). They're the same ids `hml games` prints.
- Out-of-scope line in `CLAUDE.md`: "Building a new mod repository or backend service". This stays inside it: the Worker only caches public GitHub metadata, on the backend HML already runs.

## Approaches considered

- **A. Each client searches GitHub directly.** It does the topic search, fetches manifests and latest releases, and caches locally. Rejected: unauthenticated users get 10 search requests a minute and 60 core requests an hour. Showing versions takes one call per repo, so even a modest catalog would hit the limit on first load. Every client would also validate on its own and could disagree.
- **B. Worker builds the index (chosen).** A scheduled crawl publishes one per-game index. Clients make one cheap request. Validation and the blocklist live in one place. The costs are up to an hour of listing delay, more Worker code, and a GitHub token held as a Worker secret.
- **Hybrid (Worker first, direct search as fallback).** Rejected: twice the code, and the fallback brings back A's rate-limit problem in exactly the outages it's meant to cover.

## Manifest: `hml.json`

The manifest sits at the repo root on the default branch. A single-mod repo has one entry in `mods`. A monorepo lists one entry per mod, each with its tag prefix (the same scheme as v1.8.0 monorepo support, e.g. `my-mod-v1.2.0`).

```json
{
  "$schema": "https://hml-share.<account>.workers.dev/v1/catalog/schema.json",
  "schema": 1,
  "mods": [
    {
      "id": "upgrade-queue",
      "name": "Upgrade Queue",
      "description": "Queue upgrades at the workbench.",
      "games": ["stonewards"],
      "tagPrefix": "upgrade-queue-v",
      "assetPattern": "UpgradeQueue-{version}.zip",
      "icon": "icons/upgrade-queue.png",
      "readme": "mods/upgrade-queue/README.md",
      "categories": ["QoL"],
      "dependencies": ["BepInEx-BepInExPack-5.4.2100", "github:someone/shared-lib"],
      "nsfw": false
    }
  ]
}
```

Fields:

- `schema` (required, `1`). It lets the format change later.
- `mods[]` (required, 1 to 50 entries).
  - `id` (required): unique within the repo, `[a-z0-9-]{1,64}`. The catalog key is `owner/repo/id`.
  - `name` (required, max 64 characters) and `description` (required, max 250).
  - `games` (required, 1 or more HML game labels). Known labels are:
    - the Thunderstore community slugs from the ecosystem schema, which the Worker fetches once a day from the same URL the app uses (`SCHEMA_URL` in `src/main/catalog/catalog.ts`);
    - any well-formed `nexus-<domain>` label, since Nexus has too many games to list.

    Unknown labels are dropped with a warning. A mod with no known label is rejected (`unknown-games`). `hml validate` runs the same check against the app's own cached catalog.
  - `tagPrefix` (optional): which releases belong to this mod. Required when `mods` has more than one entry.
  - `assetPattern` (optional): which release asset to install. It uses the existing `{version}` syntax. If it's absent, HML's current asset choice applies (the single zip, or ask).
  - `icon` (optional): a path in the repo, or an https URL. PNG/JPG, shown square. If it's absent, the owner's avatar is used.
  - `readme` (optional): a repo path. It defaults to the repo README.
  - `categories` (optional, free-form strings, max 5). Used only for filtering.
  - `dependencies` (optional):
    - Thunderstore full names work exactly like today's Thunderstore deps.
    - `github:owner/repo` or `github:owner/repo/id` must point at a catalog-listed mod. The `/id` is required when the target repo lists more than one mod. A GitHub dependency that isn't listed (or is blocked) doesn't reject the mod. It shows as a warning in the repo's status, and the client lists it as "unavailable" in the deps dialog, the same way a missing Thunderstore dep is handled today.
  - `nsfw` (optional, default false). Hidden unless the user's existing NSFW setting allows it, if HML has one. Otherwise it's just a badge.

A mod is listed only if it has at least one non-draft release whose tag matches its `tagPrefix` (or any release when there's no prefix), and that release has an installable asset. Pre-release-only mods are listed with a "pre-release" badge (my call).

## Worker

### Crawl (cron trigger, every 30 minutes; the builder may tune this)

**The Worker stays on the free plan** (the user's preference). Each run is limited to about 50 outbound requests and about 10 ms of CPU. So the crawl is **resumable**:
- Each run handles one or more 100-repo GraphQL pages, stops well within both limits, and saves a cursor to KV for the next run.
- While the catalog is small, one run covers everything. Once it's large, a full pass spans several runs.
- Indexes are rebuilt and written at the end of each full pass, and only if their content changed.

Each run logs its CPU time and request count. Moving to Workers Paid is a fallback for a much larger catalog, not part of this design.

1. **Use GitHub GraphQL, not REST** (my call). One `search(query: "topic:hml-mod archived:false", type: REPOSITORY, first: 100)` page returns, for each repo:
   - its numeric id, owner id, stars, `createdAt` and default-branch `hml.json` text (`object(expression: "HEAD:hml.json") { ... on Blob { text } }`);
   - its recent releases (tag, draft and pre-release flags, `publishedAt`, and asset names, sizes and download counts).

   That makes one request per 100 repos, so even 1,000 repos fit in 10 requests. This matters on the Workers free plan, where a single invocation can make only about 50 outbound requests. Monorepos with more releases than one page returns get a follow-up releases query for that repo only. Forks are listed only if they carry the topic and their own manifest.
2. Work out each mod's latest matching release and its asset from the release data.
3. Validate against the schema. Record either the listing entries or a rejection reason: `no-manifest`, `invalid-manifest: <path>: <problem>`, `no-releases`, `no-matching-asset`, `unknown-games`, `blocked`.
4. Apply the blocklist.
5. Build one index per game and a status map per repo. Write to KV **only when content changed** (compare hashes). At about 20 games and 48 crawls a day, unconditional writes would exceed the free 1,000 writes a day.

The crawl state (ETags and last results per repo) lives in one KV key, or in a small number of sharded ones if it gets large (the builder decides). With more than about 1,000 tagged repos, the 1,000-result search cap needs splitting, e.g. by `created:` date ranges. The builder can leave that for later, but should log a warning when search reports `total_count > 1000`.

A GitHub fine-grained token with public read-only access is stored as the Worker secret `GITHUB_TOKEN`.

### Routes

- `GET /v1/catalog/:game` returns the index for that game. It sends `ETag`, and HML sends `If-None-Match` so it gets a `304` back. Rate limiting is like the share download limiter. An unknown game returns `200` with an empty list (not `404`), so new games just work.
- `GET /v1/catalog/status/:owner/:repo` returns that repo's last crawl result (listed entries or rejection reason) and when it was crawled. `hml validate` uses this.
- `GET /v1/catalog/blocklist` returns the blocked owners and repos, already expanded with renames (see Blocklist).
- `GET /v1/catalog/schema.json` returns the JSON Schema.

Index entry (per mod):

```
{ key: "owner/repo/id", owner, repo, id, name, description, icon, readme, categories,
  tagPrefix, assetPattern, dependencies, nsfw,
  stars, repoCreatedAt, ownerAvatar,
  latest: { tag, version, publishedAt, prerelease, assetName, size },
  downloads,            // sum of matching release asset download_count
  updatedAt }
```

### Blocklist

The blocklist is a single KV key `catalog:blocklist`:

```
[{ "target": "owner" | "owner/repo", "reason": "...", "at": "2026-11-22" }]
```

Renames and transfers must not get a repo past the blocklist (my call). On every crawl, the Worker resolves each entry to its GitHub numeric id (owner or repo) and records every name it has seen for that id. A blocked id stays blocked under any new name, both in the index and in the served list, which includes all known names. Clients keep matching installed mods by `owner/repo` name, so the install record doesn't change.

The maintainer edits it with `wrangler kv key put`. There's no admin UI, and that's fine at this scale. The steps are documented in `worker/README.md`. The next crawl rebuilds indexes without the blocked repos, and the route serves the list immediately.

**On clients** (my call, flag if you disagree): HML fetches the blocklist with the index, and again during the existing 6-hour GitHub update check. Any installed GitHub-source mod whose owner or repo is blocked:

- has auto-update turned off and its updates skipped, whatever its update mode,
- shows a red "Blocked by HML: <reason>" badge with a Remove button.

HML never deletes the mod by itself. This applies to every GitHub-source mod, including ones installed by pasted URL.

## Client (HML app)

- **Browse tab.** Add a "GitHub" source next to Thunderstore and Nexus in the game's browse area, following `Browse.tsx` and `NexusBrowse.tsx`.
  - Search is local over name, description, owner and categories, with category filters and sorting (last updated by default, then downloads, stars, newest).
  - Rows show the icon, name, owner, version, last release and downloads, plus an "Installed" or "Update" state matched by owner/repo/tagPrefix against installed GitHub mods.
  - Tagged mods already installed by URL count as installed.
- **Detail view.** It renders the README from the manifest's `readme` path (raw GitHub, through the existing Markdown component) and shows stats, the releases list and dependencies, plus "View on GitHub" and Report.
- **Install.** The flow is: dependency resolution, then one first-owner confirmation covering every not-yet-confirmed owner among the mod and its GitHub deps (goal 5), then install. Thunderstore deps go through the existing resolver. GitHub deps are resolved from the cached index by key, one level at a time (transitively, cycles ignored), and installed with chained `ghInstall` calls before the mod itself. The mod is installed with `ghInstall` with `tagPrefix` and `assetPattern`. `assetPattern` is saved in `GhModConfig`, as the existing install option already does.
  - Updates stay purely on GitHub (the existing checker). When the 6-hour check runs and a cached index for that game exists, it refreshes a catalog-installed mod's saved `assetPattern` from the index. That way an author renaming their assets doesn't break updates. A changed `tagPrefix` isn't followed. It counts as a different mod.
  - The install follows the newest release, the same as a URL install's default update mode.
  - The installed mod records nothing new beyond its GitHub source, so share codes, sync and copy-to-profile work unchanged.
- **Caching.** HML caches the index per game on disk. It refetches when the tab opens if the cache is older than 30 minutes, using `If-None-Match`. When offline it shows the cached index with an "offline, last updated X" note.
- **Report.** This opens a prefilled GitHub issue on `darkharasho/hml` using a "Report a catalog mod" template (my call: no reporting backend).
- **CLI.**
  - `hml validate [path-or-owner/repo]`. With a file path, or no argument in a directory that has `hml.json`, it validates locally against the bundled schema and checks that the game labels are known.
  - With `owner/repo`, it shows the Worker's status for that repo and when it was last crawled.
  - Exit codes follow the existing convention: 0 is listed or valid, 1 is rejected or invalid, 2 is wrong usage.
  - Optional: `hml search <game> <query> --source github` if the CLI already has a search command for the other sources. The builder decides.
- **Copy agent instructions** (the existing feature) gains a line about `hml validate` for mod authors.

## Author docs

Add a `docs/catalog.md` (linked from the README). It covers the topic, the manifest fields with a single-mod example and a monorepo example, the listing rules, the roughly 30-minute delay, `hml validate`, and how to report or appeal a block. Your own mod repos (`REPOsitory`, `stonewards-upgrade-queue`) make good first listings and test cases.

## Left to the builder

- Exact crawl interval and KV key layout (within the write budget).
- Schema validation library in the Worker (or hand-written checks), and how the schema file is shared between the Worker and the app/CLI.
- Browse-tab layout details, following the existing browse views.
- Test strategy. It follows the repo's existing vitest setup, run with `--maxWorkers=2`.
