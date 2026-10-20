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
