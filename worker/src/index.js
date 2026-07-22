// Gage board-card Worker
// =======================
// Serves the in-tweet share cards + a human on-ramp for Gage, the
// turn-by-turn "board games on X" platform. This Worker has NO game logic:
// it only base64url-decodes a seed's `meta` bag and reads/writes PNGs in R2.
//
// Routed (see wrangler.toml) for:
//   gage.coze.org/g/*     -> Twitter/OG card HTML for a game seed
//   gage.coze.org/img/*   -> the board PNG for a position (R2-backed)
// The rest of gage.coze.org is GitHub Pages.
//
// Contract:
//   Seed  <seed>  in /g/<seed> = base64url(JSON.stringify({
//     v:1, game:"chess", state:{...},
//     meta:{ w, b, turn, san, key }
//   }))
//     - w,b   : player handles (may be empty)
//     - turn  : "w" | "b" (side to move)
//     - san   : last move text (e.g. "Nf3")
//     - key   : the /img/<key>.png position cache-key
//   base64url = standard base64 with + -> -, / -> _, no padding.
//
//   Image key <key> in /img/<key>.png = a URL-safe ASCII string
//   (chess piece-placement with '/' -> '-'). Constrained to a safe charset
//   before we ever touch R2.
//
// The Worker is defensive everywhere: a malformed seed yields a safe default
// card (never a 500), and a missing image yields a short-cached placeholder
// PNG (never a 500) so a not-yet-uploaded position isn't pinned by CDN caches.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ORIGIN = "https://gage.coze.org";
const SITE_URL = ORIGIN + "/"; // GitHub Pages landing / extension on-ramp
const REPO_URL = "https://github.com/c0ze/gage.coze.org";

// Safe charset for an /img/<key>.png key. Piece-placement uses letters, digits
// and '-' (from '/'); we also allow '.' and '_' for headroom. Anchored + length
// capped so a hostile key can't smuggle path traversal or blow up R2 keys.
const KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;

// Upload guardrails.
const MAX_IMAGE_BYTES = 262144; // 256 KiB — a board PNG is a few KB; this is slack.

// Long/immutable cache for a real board image (a position never changes), vs.
// a short cache for the placeholder so the real image replaces it quickly.
const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
const CACHE_SHORT = "public, max-age=60";

// A tiny valid PNG: a 2x2 solid tile in the board's dark green (#769656).
// Twitter/OG scale it to fill the card, so it reads as "board still loading"
// rather than a broken image. Embedded as base64 so the Worker ships one file
// with zero image deps and never renders anything itself.
const FALLBACK_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR42mMomxYGRAwQCgAnRgWJ/PFUxAAAAABJRU5ErkJggg==";

// Decode the fallback once at module load into an immutable byte buffer.
const FALLBACK_PNG = base64ToBytes(FALLBACK_PNG_B64);

// Map a seed's `game` id to a human display name for the card. The Worker has
// no game logic — this is purely presentational. Unknown ids fall back to a
// capitalized form of the id (or "Board" if the id is unusable), so a new game
// still renders a sensible card without a Worker change.
const GAME_NAMES = {
  chess: "Chess",
  checkers: "Checkers",
  reversi: "Reversi",
  gomoku: "Gomoku",
};

// gameDisplayName(id) -> a safe, human display name. Never throws; always a
// non-empty string. Interpolated values are still HTML-escaped at render time.
function gameDisplayName(id) {
  if (typeof id !== "string" || id.length === 0) return "Board";
  // Own-property lookup only: an id like "constructor"/"__proto__" must NOT
  // resolve an inherited property (which would render built-in text).
  const known = Object.prototype.hasOwnProperty.call(GAME_NAMES, id)
    ? GAME_NAMES[id]
    : null;
  if (known) return known;
  // Unknown id: capitalize the first character; the rest is left as-is (it's
  // still escaped downstream). If the id is only whitespace, fall back to Board.
  const trimmed = id.trim();
  if (trimmed.length === 0) return "Board";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Standard base64 -> Uint8Array (atob is available in the Workers runtime).
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// HTML-escape an interpolated value. Handles and SAN are attacker-controllable
// (they come straight out of the seed), so EVERYTHING interpolated into the
// page — text nodes AND attribute values — goes through this first. We escape
// the five HTML-significant characters, which is sufficient for both contexts
// given we always quote attributes with double quotes.
function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// base64url -> UTF-8 string. Mirrors src/seed.js b64urlDecode exactly:
// reverse the URL-safe substitutions, then atob, then decode bytes as UTF-8 so
// non-ASCII handles survive. Padding is optional for atob in the Workers
// runtime, so we don't need to re-pad.
function b64urlDecodeToString(seed) {
  const b64 = String(seed).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// decodeSeedMeta(seed) -> meta object, always. This is the ONLY seed parsing the
// Worker does: it pulls the `meta` bag and never interprets `state` (no game
// logic here). Any failure — bad base64, bad JSON, missing meta — collapses to
// a sane default so /g/<seed> can still render a card instead of 500ing.
function decodeSeedMeta(seed) {
  const fallback = { w: "", b: "", turn: "w", san: "", key: "", game: "chess" };
  try {
    const env = JSON.parse(b64urlDecodeToString(seed));
    const meta = env && env.meta ? env.meta : {};
    return {
      w: typeof meta.w === "string" ? meta.w : "",
      b: typeof meta.b === "string" ? meta.b : "",
      // Only "w"/"b" are meaningful; anything else defaults to white-to-move.
      turn: meta.turn === "b" ? "b" : "w",
      san: typeof meta.san === "string" ? meta.san : "",
      key: typeof meta.key === "string" ? meta.key : "",
      // Top-level envelope field (NOT under meta). Defaults to "chess" when
      // absent or non-string so older seeds keep working.
      game: typeof env.game === "string" && env.game ? env.game : "chess",
    };
  } catch (_e) {
    return fallback;
  }
}

// JSON response helper.
function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign(
      { "content-type": "application/json; charset=utf-8" },
      extraHeaders || {},
    ),
  });
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
// The landing site and the browser extension live on DIFFERENT origins from
// this Worker, and both PUT board images here. So /img/* is intentionally open:
// permissive CORS + first-write-wins as the integrity guard (see PUT below).
//
// NOTE: uploads are best-effort and low-stakes (a cached board image). If this
// ever needs hardening, the upload could require an HMAC-signed key/body (the
// extension and site share a secret; the Worker verifies) instead of relying
// on first-write-wins. Left permissive on purpose for v1.
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, PUT, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

// ---------------------------------------------------------------------------
// Route: GET /g/<seed>  -> Twitter/OG card HTML + human on-ramp
// ---------------------------------------------------------------------------
function handleCard(seed) {
  const meta = decodeSeedMeta(seed);

  // Image URL: prefer the seed's cache-key; if absent we still build a URL, and
  // /img/* will serve the placeholder for a missing/empty key.
  const imgUrl = ORIGIN + "/img/" + encodeURIComponent(meta.key) + ".png";

  const sideToMove = meta.turn === "w" ? "White" : "Black";

  // Human display name for the game (e.g. "Chess", "Checkers"). Defensive:
  // gameDisplayName never throws and always returns a non-empty string.
  const gameName = gameDisplayName(meta.game);

  // Card title/description (per contract). Built from raw meta; every value is
  // escaped at interpolation time below — never trust handles/SAN.
  const title =
    "♟ " + gameName + " challenge" +
    (meta.w ? " — @" + meta.w + " vs @" + meta.b : "");
  const description =
    sideToMove +
    " to move" +
    (meta.san ? " · last: " + meta.san : "") +
    " — play on X with Gage";

  // Body on-ramp line, e.g. "@alice challenged @bob to Chess — it's w to move".
  const challenger = meta.w || "someone";
  const opponent = meta.b || "you";
  const onramp =
    "@" +
    challenger +
    " challenged @" +
    opponent +
    " to " +
    gameName +
    " — it's " +
    meta.turn +
    " to move";

  // Everything interpolated is escaped. Attributes are double-quoted so esc()'s
  // handling of " and & is sufficient for attribute-value context too.
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(imgUrl)}">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">

<meta property="og:type" content="website">
<meta property="og:image" content="${esc(imgUrl)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">

<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 2rem 1rem;
    font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    display: flex; flex-direction: column; align-items: center; gap: 1rem;
    background: #f6f6f4; color: #1a1a1a;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #14140f; color: #e8e8e2; }
  }
  .board { width: min(90vw, 480px); height: auto; border-radius: 8px;
           box-shadow: 0 2px 12px rgba(0,0,0,.25); }
  h1 { font-size: 1.25rem; margin: .25rem 0 0; text-align: center; }
  p  { margin: .25rem 0; text-align: center; max-width: 40rem; }
  .cta { display: inline-block; margin-top: .5rem; padding: .6rem 1.1rem;
         background: #769656; color: #fff; text-decoration: none;
         border-radius: 6px; font-weight: 600; }
  .muted { opacity: .7; font-size: .9rem; }
  a { color: #4a7; }
</style>
</head>
<body>
  <img class="board" src="/img/${esc(meta.key)}.png"
       alt="${esc(gameName)} board — ${esc(sideToMove)} to move"
       width="480" height="480">
  <h1>${esc(onramp)}</h1>
  <p>Gage lets you play board games turn-by-turn right inside X (Twitter) —
     one move per reply, no Twitter API.</p>
  <a class="cta" href="${esc(SITE_URL)}">Install the Gage extension</a>
  <p class="muted">Learn more at
     <a href="${esc(SITE_URL)}">gage.coze.org</a> ·
     source on <a href="${esc(REPO_URL)}">GitHub</a>.</p>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Cards can change as a game advances (same URL is not reused per move —
      // each move has a fresh seed — but keep it modest just in case).
      "cache-control": "public, max-age=300",
    },
  });
}

// ---------------------------------------------------------------------------
// Route: GET /img/<key>.png  -> the board PNG from R2 (or placeholder)
// ---------------------------------------------------------------------------
async function handleImageGet(env, key) {
  // Validated key => safe to touch R2. A hit is immutable & long-cached; a miss
  // returns the placeholder with a SHORT cache so it isn't pinned once the real
  // image is uploaded. Either way, CORS is open and we never 500.
  const obj = await env.BUCKET.get(key);
  if (obj) {
    const headers = new Headers();
    headers.set("content-type", "image/png");
    headers.set("cache-control", CACHE_IMMUTABLE);
    headers.set("access-control-allow-origin", "*");
    // Let R2 supply an etag when available (helps conditional requests).
    if (obj.httpEtag) headers.set("etag", obj.httpEtag);
    return new Response(obj.body, { status: 200, headers });
  }
  return placeholderResponse();
}

// The not-found placeholder PNG response: valid PNG bytes, short cache, open
// CORS. A 200 (not 404) so Twitter/clients render it as a normal image.
function placeholderResponse() {
  return new Response(FALLBACK_PNG, {
    status: 200,
    headers: {
      "content-type": "image/png",
      "cache-control": CACHE_SHORT,
      "access-control-allow-origin": "*",
    },
  });
}

// ---------------------------------------------------------------------------
// Route: PUT /img/<key>.png  -> upload a board PNG (first-write-wins)
// ---------------------------------------------------------------------------
async function handleImagePut(env, key, request) {
  // First-write-wins: if this position's image already exists, DON'T overwrite.
  // A position is content-addressed by `key`, so the first correct upload is
  // authoritative; refusing later writes prevents cache-poisoning an existing
  // board with different bytes. Return 200 {skipped:true} — a no-op success.
  const existing = await env.BUCKET.head(key);
  if (existing) {
    return json({ skipped: true }, 200, { "access-control-allow-origin": "*" });
  }

  // Validate the upload: must declare image/png and be under the size cap.
  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("image/png")) {
    return json({ error: "content-type must be image/png" }, 400, {
      "access-control-allow-origin": "*",
    });
  }

  // Read the body once as bytes so we can length-check it precisely (a
  // content-length header alone is spoofable / may be absent for streams).
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength === 0 || body.byteLength >= MAX_IMAGE_BYTES) {
    return json({ error: "png body must be 1..262143 bytes" }, 400, {
      "access-control-allow-origin": "*",
    });
  }

  // Store it. contentType is pinned to image/png so a later GET always serves
  // the right type regardless of what the client claimed.
  await env.BUCKET.put(key, body, {
    httpMetadata: { contentType: "image/png" },
  });

  return json({ uploaded: true }, 201, { "access-control-allow-origin": "*" });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS preflight for the cross-origin PUT from the site/extension.
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // ---- /g/<seed> : card HTML -------------------------------------------
  if (path.startsWith("/g/")) {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "GET" },
      });
    }
    // Everything after "/g/" is the seed. It's untrusted input, but decoding is
    // fully defensive (decodeSeedMeta never throws), so no charset gate needed.
    const seed = path.slice("/g/".length);
    return handleCard(seed);
  }

  // ---- /img/<key>.png : board PNG --------------------------------------
  if (path.startsWith("/img/")) {
    // Extract "<key>" from "/img/<key>.png". Require the .png suffix so the
    // route shape is explicit and the key can't accidentally include it.
    const rest = path.slice("/img/".length);
    if (!rest.toLowerCase().endsWith(".png")) {
      return json({ error: "expected /img/<key>.png" }, 400, {
        "access-control-allow-origin": "*",
      });
    }
    const key = rest.slice(0, -".png".length);

    // Validate the key charset BEFORE touching R2 — rejects path traversal,
    // oversized keys, and anything outside the safe set.
    if (!KEY_RE.test(key)) {
      return json({ error: "invalid image key" }, 400, {
        "access-control-allow-origin": "*",
      });
    }

    if (request.method === "GET") return handleImageGet(env, key);
    if (request.method === "PUT") return handleImagePut(env, key, request);

    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, PUT, OPTIONS", "access-control-allow-origin": "*" },
    });
  }

  // Anything else isn't ours (GitHub Pages serves the rest of the site). If the
  // route ever sends us a non-/g//img path, 404 rather than pretend.
  return new Response("Not Found", { status: 404 });
}

// ES module Worker entrypoint. Wrap the router so an unexpected throw becomes a
// 500 with no body rather than an opaque runtime error — but the per-route code
// is written so this should never trigger for normal input.
export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env);
    } catch (_e) {
      return new Response("Internal Error", { status: 500 });
    }
  },
};

// Also export the router + a couple of pure helpers so tests can drive the
// handler with a fake env (no wrangler/miniflare needed). See test/worker.test.mjs.
export { handle, decodeSeedMeta, esc };
