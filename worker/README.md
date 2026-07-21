# Gage board-card Worker

A tiny Cloudflare Worker that serves the in-tweet share cards and a human
on-ramp for [Gage](https://gage.coze.org). It has **no game logic** — it only
base64url-decodes a seed's `meta` bag and reads/writes board PNGs in R2.

Origin is `https://gage.coze.org`. The Worker is routed for **`/g/*`** and
**`/img/*`** only; **GitHub Pages serves the rest of the site** (the landing
page, `/lib`, assets, `CNAME`).

## Routes & behavior

| Method & path         | Behavior                                                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /g/<seed>`       | Decodes the seed's `meta` and returns HTML with `twitter:*` + `og:*` card tags (image = `/img/<meta.key>.png`) and a simple on-ramp body. Malformed seed → safe default card (never 500). |
| `GET /img/<key>.png`  | Returns the PNG from R2 (`content-type: image/png`, immutable 1-year cache). Missing → a small inline placeholder PNG with a 60s cache (so a not-yet-uploaded image isn't pinned). Never 500. |
| `PUT /img/<key>.png`  | First-write-wins upload. If the key exists → `200 {skipped:true}` (no overwrite). Else validates `image/png` + body `< 262144` bytes, stores it → `201 {uploaded:true}`. Invalid input → `400`. |
| `OPTIONS *`           | CORS preflight: `Allow-Origin *`, `Allow-Methods GET, PUT, OPTIONS`, `Allow-Headers content-type`.                                                                     |

`<seed>` is base64url of `{ v:1, game:"chess", state:{...}, meta:{ w, b, turn, san, key } }`.
`<key>` is constrained to `^[A-Za-z0-9._-]{1,128}$` before any R2 access; other
keys get `400`. `/img/*` responses carry `access-control-allow-origin: *` because
the site and the extension (different origins) both upload here. First-write-wins
is the integrity guard; an HMAC-signed upload could harden this later (see the
comment in `src/index.js`).

## Deploy

Requires the [`wrangler`](https://developers.cloudflare.com/workers/wrangler/)
CLI and that **`coze.org` is a zone on the target Cloudflare account** (the
routes in `wrangler.toml` use `zone_name = "coze.org"`).

```sh
# from this directory: worker/
wrangler login                               # one-time browser auth
wrangler r2 bucket create gage-board-cache   # one-time; matches [[r2_buckets]].bucket_name
wrangler deploy                              # publishes the Worker + installs the routes
```

`wrangler deploy` registers the `gage.coze.org/g/*` and `gage.coze.org/img/*`
routes automatically from `wrangler.toml`. If you prefer the dashboard, add them
under **Workers & Pages → your Worker → Settings → Triggers → Routes** (zone
`coze.org`). No route or DNS change is needed for GitHub Pages — it keeps serving
every path outside `/g/*` and `/img/*`.

## Test

No wrangler/miniflare needed — the test drives the exported `handle(request, env)`
with an in-memory fake R2 bucket:

```sh
node test/worker.test.mjs
```
