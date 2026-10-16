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
