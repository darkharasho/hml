# List your mod in the HML GitHub catalog

HML's Online tab has a GitHub source. It shows mods from public GitHub repos that opt in. Users can search, install and update them from inside HML.

To list a mod you do three things:

1. Add the `hml-mod` topic to your repo.
2. Add an `hml.json` file at the repo root.
3. Publish a GitHub release with a `.zip` asset.

HML does not host your mod. It reads your repo and your releases.

## The hml.json file

The file must be at the repo root, on the default branch, and no larger than 64 KB.

### Single mod

```json
{
  "$schema": "https://hml-share.project96.workers.dev/v1/catalog/schema.json",
  "schema": 1,
  "mods": [
    {
      "id": "better-flashlight",
      "name": "Better Flashlight",
      "description": "A brighter flashlight with a longer beam.",
      "games": ["repo"],
      "categories": ["tweaks"]
    }
  ]
}
```

### Monorepo

If one repo holds several mods, give each mod a `tagPrefix`. HML uses it to tell which releases belong to which mod. A tag like `infinite-energy-v0.1.0` has the prefix `infinite-energy`.

```json
{
  "$schema": "https://hml-share.project96.workers.dev/v1/catalog/schema.json",
  "schema": 1,
  "mods": [
    {
      "id": "infinite-energy",
      "name": "Infinite Energy",
      "description": "Removes the energy limit.",
      "games": ["repo"],
      "tagPrefix": "infinite-energy",
      "assetPattern": "InfiniteEnergy-{version}.zip",
      "dependencies": ["BepInEx-BepInExPack-5.4.2100"]
    },
    {
      "id": "faerie-flight",
      "name": "Faerie Flight",
      "description": "Lets you glide for a short time.",
      "games": ["repo", "nexus-skyrim"],
      "tagPrefix": "faerie-flight",
      "icon": "assets/faerie.png",
      "readme": "faerie-flight/README.md"
    }
  ]
}
```

### Fields

Top level:

| Field | Required | Rule |
| --- | --- | --- |
| `$schema` | No | The schema URL above. Editors use it for completion. HML ignores it. |
| `schema` | Yes | Must be `1`. |
| `mods` | Yes | 1 to 50 mods. |

Each entry in `mods`:

| Field | Required | Rule |
| --- | --- | --- |
| `id` | Yes | Matches `^[a-z0-9-]{1,64}$`. Unique in the file. |
| `name` | Yes | 1 to 64 characters. |
| `description` | Yes | 1 to 250 characters. |
| `games` | Yes | 1 to 20 game labels, each up to 64 characters. See [Game labels](#game-labels). |
| `tagPrefix` | When `mods` has more than one entry | 1 to 64 characters. The text before the version in your release tags. |
| `assetPattern` | No | 1 to 200 characters, with at most 2 `{version}` tokens. Picks the release asset by name. `{version}` matches a version number. Without it, HML takes the first `.zip` asset. |
| `icon` | No | An `https://` URL or a path in the repo. Defaults to your GitHub avatar. |
| `readme` | No | A path in the repo. URLs are not allowed. Defaults to `README.md`. |
| `categories` | No | Up to 5 labels, each 1 to 32 characters. Defaults to none. |
| `dependencies` | No | Up to 50 mods to install first, each up to 200 characters. Defaults to none. See [Dependencies](#dependencies). |
| `nsfw` | No | `true` or `false`. Defaults to `false`. |

Repo paths (`readme`, and `icon` when it isn't a URL) must be relative. They can't start with `/`, contain `\`, contain `..`, or start with a scheme like `file:`. They can be up to 300 characters. Icon URLs can be up to 500 characters.

### Game labels

A game label is a Thunderstore community slug, like `repo` or `lethal-company`. The list is at <https://thunderstore.io/api/experimental/community/>.

For Nexus Mods games, use a label that matches `^nexus-[a-z0-9-]+$`, like `nexus-skyrim`.

HML drops labels it doesn't know and keeps the rest. If none of a mod's labels are known, the repo is rejected with `unknown-games`.

### Dependencies

Each entry is one of:

- A Thunderstore package with its version: `Owner-Name-1.2.3`.
- A GitHub mod in the catalog: `github:owner/repo`, or `github:owner/repo/mod-id`. Without a mod id, the repo must list exactly one mod.

HML installs dependencies before your mod. A dependency it can't find is reported to the user and skipped.

## Releases

HML lists a mod from its newest non-draft release that has a matching asset. A stable release wins over a newer prerelease. If you only have prereleases, HML lists the newest one.

- With a single mod and no `tagPrefix`, every release counts.
- With a `tagPrefix`, only releases whose tag has that prefix count. The match ignores case, and a trailing separator or `v` in the prefix is fine (`infinite-energy-v` works).
- The asset is the first `.zip`, or the first one that matches `assetPattern`.

## How listing works

A Cloudflare Worker searches GitHub for repos with the `hml-mod` topic. It reads each repo's `hml.json` and releases, and publishes the result.

The catalog updates every 30 minutes. A full pass can take longer for a large catalog. A new repo or a new release can take that long to show up.

## Check your listing

Use `hml validate` from HML's command line (HML Settings, Command line):

```
hml validate                 # checks hml.json in the current folder
hml validate path/to/dir     # checks hml.json in that folder
hml validate path/hml.json   # checks that file
hml validate owner/repo      # shows the repo's listing status in the catalog
```

For a local file, it checks the schema and your game labels. It doesn't check your releases.

For `owner/repo`, it shows when the repo was last crawled and what it lists. If the repo hasn't been crawled yet, it prints:

```
Not in the catalog yet. Add the hml-mod topic; the catalog updates every 30 minutes.
```

Exit codes:

- `0`: the file is valid, or the repo is listed.
- `1`: the file is invalid, or the repo is rejected or not in the catalog.
- `2`: wrong usage.

## Why a repo is not listed

When a repo is rejected, `hml validate owner/repo` shows one of these reasons.

| Reason | Meaning | Fix |
| --- | --- | --- |
| `no-manifest` | There is no `hml.json` at the repo root of the default branch. | Add the file and push it to the default branch. |
| `invalid-manifest: <path>: <problem>` | The file isn't valid JSON, is over 64 KB, or breaks a rule in the field table. `<path>` is the field, like `mods.0.id`. `(root)` means the file as a whole. | Fix the field named in the message. Run `hml validate` locally. |
| `no-releases` | No non-draft release matches the mod. In a monorepo, none has the mod's `tagPrefix`. | Publish a release. Check that its tag starts with the `tagPrefix`. |
| `no-matching-asset` | The releases have no asset that fits: no `.zip`, or none that matches `assetPattern`. | Attach a `.zip` to the release, or fix `assetPattern`. |
| `unknown-games` | None of a mod's `games` labels is a known game. | Use a Thunderstore community slug or a `nexus-` label. |
| `blocked` | HML's maintainer blocklist includes the repo. | See [Blocked mods](#blocked-mods). |

For a repo with several mods, a mod that fails stays out and the others are still listed. The status shows a warning like `faerie-flight: not listed (no-releases)`. The repo is rejected only when no mod can be listed.

## Safety

HML does not review mods from GitHub. Users install them at their own risk. The first time a user installs from a new author, HML asks them to confirm.

HML keeps a blocklist. A blocked mod disappears from the catalog. If a user has it installed, HML shows "Blocked by HML: {reason}" and stops updating it.

## Blocked mods

To report a mod, open an issue with the [catalog report template](https://github.com/darkharasho/hml/issues/new?template=catalog-report.yml). HML's report link opens the same form with the repo filled in.

If your repo was blocked and you think that's wrong, appeal by opening an issue on [darkharasho/hml](https://github.com/darkharasho/hml/issues/new). Give the repo URL and say what changed or why the block doesn't apply.
