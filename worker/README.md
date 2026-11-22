# hml-share

Cloudflare Worker that stores HML profile share zips in KV under short codes.

## Deploy

Fill in the KV namespace id in `wrangler.jsonc`, then from this directory:

```
npx wrangler@4 deploy
```

## API

- `POST /v1/profiles`: body is the `.hml` zip (max 10 MB, 5 uploads per minute per IP).
  The zip's first entry must be `export.json`. Returns `201 {"code": "ABCDEFGHJK"}`.
  Errors: `400 not-a-zip`, `400 not-an-hml`, `413 too-large`, `429 rate-limited`,
  `500 code-collision`.
- `GET /v1/profiles/:code`: returns the zip (`application/zip`, 60 downloads per minute per IP,
  `cache-control: public, max-age=86400, immutable`). Codes are 10 Crockford base32
  characters; case, dashes and look-alikes (O, I, L) are normalized. Errors: `400 bad-code`,
  `404 not-found`, `429 rate-limited`.

Profiles expire after one year (KV `expirationTtl`).

## Sync routes

Synced profiles let an owner publish revisions of a profile under a 12-character code
(`XXXX-XXXX-XXXX`); followers poll cheaply for newer revisions. Bodies are `.hml` zips, validated
like share uploads. Every response carries `cache-control: no-store`.

- `POST /v1/sync` (10 per minute per IP): returns `201 {"code", "ownerKey", "revision": 1}`.
  The server stores only the SHA-256 of `ownerKey`.
- `PUT /v1/sync/:code` with `authorization: Bearer <ownerKey>` (same limiter): publishes the next
  revision, `200 {"revision": N}`. Errors: `401 bad-key`, `404 not-found`, `410 ended`.
- `GET /v1/sync/:code?since=N` (30 per minute per IP): `304` with `x-hml-revision` when the latest
  revision is at most N, otherwise `200` with the zip and `x-hml-revision`. Errors: `404`, `410 ended`.
- `DELETE /v1/sync/:code` with bearer: stops syncing (`204`) by writing an `ended` tombstone.

Free-tier budget: one KV write per publish or stop. Each check is one KV metadata read: the
revision lives in the entry's metadata and the body is streamed and cancelled unless the check
returns the zip, so a `304` or `410` never reads the body. The Worker also caches the revision
metadata for 60 seconds (`https://sync-meta.hml/<code>`, dropped on PUT and DELETE), but the Cache
API only works on a custom domain; on `workers.dev` it does nothing and every check reads KV.
Entries expire after one year, refreshed on every publish.

## GitHub catalog

A cron trigger (`*/30 * * * *`) crawls GitHub for repos with the `hml-mod` topic and an `hml.json`
at the default branch root, and serves per-game indexes of the mods it lists. Set the token first
(fine-grained, public repositories read-only):

```
npx wrangler@4 secret put GITHUB_TOKEN
```

Routes (`GET` only, 120 per minute per IP via `CATALOG_LIMITER`, `cache-control: public, max-age=300`;
other methods get `405 method-not-allowed`, the limiter `429 rate-limited`):

- `GET /v1/catalog/:game` (`[a-z0-9-]{1,64}`): `200 {"game", "builtAt", "mods": CatalogEntry[]}` with
  an `ETag`; `304` when `If-None-Match` matches. A game without an index gets `200` with `mods: []`.
- `GET /v1/catalog/status/:owner/:repo`: the repo's last crawl result (`listed`, `warnings`,
  `rejected`), matched case-insensitively. `404 not-crawled` if the crawl hasn't seen it.
- `GET /v1/catalog/blocklist`: `{"entries": [{"names": [...], "reason"}]}`. `names` are lowercase
  `owner` or `owner/repo`, including names a blocked repo or owner had before a rename.
- `GET /v1/catalog/schema.json`: the JSON Schema for `hml.json`.

Free-tier budget: each run first refreshes the Thunderstore community list if it is missing or over
24 hours old, and does nothing else that run. Otherwise it fetches at most 3 GraphQL search pages
(a 502/504 is retried once at page size 15) and saves its cursor, so a pass spans several runs. The
indexes and status map are written only when a pass finishes. Every catalog value carries the
SHA-256 of its content in its KV metadata and is written only when that hash changes (`builtAt` and
`crawledAt` don't count), so an unchanged pass writes nothing. Each run logs
`{"catalog":"run","pages","repos","writes","ms"}`, and warns when the search total passes GitHub's
1,000-result cap.

KV keys (all in `PROFILES`):

- `catalog:index:<game>`: the `CatalogIndex` served for that game.
- `catalog:status`: lowercase `owner/repo` to `RepoStatus`, from the last finished pass.
- `catalog:state`: crawl progress (`cursor`, the current pass's statuses, search `total`, the
  blocklist's resolved GitHub ids, and the games indexed last pass).
- `catalog:games`: `{"fetchedAt", "slugs"}`, Thunderstore communities with a mod loader.
- `catalog:blocklist`: `BlockEntry[]`, edited by hand. `target` is `owner` or `owner/repo`
  (case-insensitive); blocks follow renames once the crawl has seen the repo or owner. To edit:

```
npx wrangler@4 kv key put --binding PROFILES catalog:blocklist '[{"target":"owner/repo","reason":"malware","at":"2026-11-22"}]'
```

The new list takes effect on the next pass.
