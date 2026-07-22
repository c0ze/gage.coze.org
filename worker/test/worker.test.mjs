// Node test for the Gage board-card Worker — no wrangler / miniflare.
//
// It imports the exported `handle(request, env)` from ../src/index.js and calls
// it with a FAKE env.BUCKET: an in-memory Map that implements the subset of the
// R2 API the Worker uses (get / head / put). We assert the contract:
//   - /g/<seed> returns HTML with the right twitter:image URL + escaped title
//   - a malformed seed still returns a 200 card
//   - PUT /img/<key> stores, then a 2nd PUT skips (first-write-wins)
//   - PUT guards: 411 no content-length, 413 too big (declared or actual),
//     415 bytes that aren't a real PNG (see ../src/png.js + worker/png.test.mjs)
//   - GET /img/<key> returns the stored bytes
//   - an invalid key => 400
//   - OPTIONS returns CORS headers
//   - a missing image => 200 placeholder PNG (short cache)
//
// Run: node worker/test/worker.test.mjs   (or: node test/worker.test.mjs from worker/)

import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/index.js";

// ---------------------------------------------------------------------------
// Fake R2 bucket: enough of the interface for the Worker.
//   put(key, body)  -> stores bytes (Uint8Array)
//   head(key)       -> truthy metadata if present, else null
//   get(key)        -> { body, httpEtag } if present, else null
// The Worker returns obj.body straight into a Response; a Uint8Array is a valid
// BodyInit in Node's fetch/undici, so a real byte round-trip is exercised.
// ---------------------------------------------------------------------------
function makeBucket() {
  const store = new Map();
  return {
    _store: store,
    async put(key, body, _opts) {
      const bytes =
        body instanceof Uint8Array ? body : new Uint8Array(body);
      store.set(key, bytes);
      return { key };
    },
    async head(key) {
      return store.has(key) ? { key, size: store.get(key).byteLength } : null;
    },
    async get(key) {
      if (!store.has(key)) return null;
      return { body: store.get(key), httpEtag: '"fake-etag"' };
    },
  };
}

// Build a valid base64url seed from a meta bag (mirrors src/seed.js encoding).
// `game` sets the top-level envelope game id (defaults to "chess").
function makeSeed(meta, game = "chess") {
  const envelope = { v: 1, game, state: { game }, meta };
  const jsonStr = JSON.stringify(envelope);
  // Node: utf-8 -> base64 -> url-safe, strip padding.
  return Buffer.from(jsonStr, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const req = (method, path, opts = {}) =>
  new Request("https://gage.coze.org" + path, { method, ...opts });

// A structurally valid minimal PNG head (signature + IHDR for size x size) so
// PUT bodies pass the Worker's real-bytes validation (../src/png.js).
function validPngBytes(size = 316) {
  const u32be = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
    ...u32be(13), 0x49, 0x48, 0x44, 0x52, // IHDR chunk length + type
    ...u32be(size), ...u32be(size), // width, height
    8, 6, 0, 0, 0, // bit depth, color type, compression, filter, interlace
    0, 0, 0, 0, // CRC (unchecked by the validator)
  ]);
}

// PUT helper. Node's Request does NOT auto-add content-length for byte bodies
// (undici computes it at send time), so PUT tests set it explicitly — matching
// what fetch sends on the wire for the extension's canvas.toBlob uploads.
const putPng = (key, bytes, headers = {}) =>
  req("PUT", "/img/" + key + ".png", {
    headers: {
      "content-type": "image/png",
      "content-length": String(bytes.byteLength),
      ...headers,
    },
    body: bytes,
  });

// ---------------------------------------------------------------------------

test("/g/<seed> returns HTML with correct twitter:image + escaped title", async () => {
  const env = { BUCKET: makeBucket() };
  const seed = makeSeed({
    w: "alice",
    b: "bob",
    turn: "b",
    san: "Nf3",
    key: "rnbqkbnr-pppppppp",
  });
  const res = await handle(req("GET", "/g/" + seed), env);

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/html/);

  const html = await res.text();
  // twitter card type + the image URL derived from meta.key
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.match(
    html,
    /name="twitter:image" content="https:\/\/gage\.coze\.org\/img\/rnbqkbnr-pppppppp\.png"/,
  );
  // og mirror
  assert.match(
    html,
    /property="og:image" content="https:\/\/gage\.coze\.org\/img\/rnbqkbnr-pppppppp\.png"/,
  );
  // title contains the handles
  assert.match(html, /@alice vs @bob/);
  // "Black to move" (turn=b) + last move
  assert.match(html, /Black to move · last: Nf3/);
});

test("/g/<seed> is game-aware: a checkers seed yields a Checkers card", async () => {
  const env = { BUCKET: makeBucket() };
  const seed = makeSeed(
    { w: "alice", b: "bob", turn: "w", san: "", key: "checkers-start" },
    "checkers",
  );
  const res = await handle(req("GET", "/g/" + seed), env);
  assert.equal(res.status, 200);
  const html = await res.text();
  // Title reflects the game name, not a hardcoded "Chess".
  assert.match(html, /Checkers challenge/);
  assert.ok(!/Chess challenge/.test(html), "leaked hardcoded Chess title");
  // On-ramp line uses the display name.
  assert.match(html, /challenged @bob to Checkers/);
  // Board alt text is game-aware.
  assert.match(html, /Checkers board/);
});

test("/g/<seed> with an unknown game id capitalizes it (still renders)", async () => {
  const env = { BUCKET: makeBucket() };
  const seed = makeSeed(
    { w: "alice", b: "bob", turn: "w", san: "", key: "xiangqi-start" },
    "xiangqi",
  );
  const res = await handle(req("GET", "/g/" + seed), env);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Xiangqi challenge/);
});

test("/g/<seed> with a prototype-key game id doesn't leak built-in text", async () => {
  const env = { BUCKET: makeBucket() };
  // "constructor" is an inherited property on a plain object — the display-name
  // lookup must be own-property only, or it renders "function Object() {...}".
  const seed = makeSeed(
    { w: "alice", b: "bob", turn: "w", san: "", key: "k" },
    "constructor",
  );
  const res = await handle(req("GET", "/g/" + seed), env);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(!/native code/.test(html), "leaked built-in function text");
  // Falls through to the capitalize path.
  assert.match(html, /Constructor challenge/);
});

test("/g/<seed> with no game field defaults to Chess (back-compat)", async () => {
  const env = { BUCKET: makeBucket() };
  // Hand-build an envelope WITHOUT a top-level game field.
  const envelope = { v: 1, state: {}, meta: { w: "a", b: "b", turn: "w", san: "", key: "k" } };
  const seed = Buffer.from(JSON.stringify(envelope), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const res = await handle(req("GET", "/g/" + seed), env);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Chess challenge/);
});

test("/g/<seed> escapes attacker-controllable handles (no raw injection)", async () => {
  const env = { BUCKET: makeBucket() };
  // A handle carrying HTML-significant characters must not appear raw.
  const seed = makeSeed({
    w: '"><script>x</script>',
    b: "bob",
    turn: "w",
    san: "",
    key: "start",
  });
  const res = await handle(req("GET", "/g/" + seed), env);
  const html = await res.text();
  assert.equal(res.status, 200);
  // The raw payload must be absent; its escaped form present.
  assert.ok(!html.includes("<script>x</script>"), "raw script tag leaked");
  assert.match(html, /&lt;script&gt;/);
});

test("malformed seed still returns a 200 card (safe default)", async () => {
  const env = { BUCKET: makeBucket() };
  // "!!!!" is not valid base64url JSON — must not 500.
  const res = await handle(req("GET", "/g/!!!!not-a-seed!!!!"), env);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /text|Chess/i);
  // default turn is white
  assert.match(html, /White to move/);
});

test("PUT /img/<key> stores, then a second PUT skips (first-write-wins)", async () => {
  const env = { BUCKET: makeBucket() };
  const key = "position-abc";
  const bytes = validPngBytes(316);

  const res1 = await handle(putPng(key, bytes), env);
  assert.equal(res1.status, 201);
  assert.deepEqual(await res1.json(), { uploaded: true });
  assert.equal(res1.headers.get("access-control-allow-origin"), "*");

  // Second PUT with DIFFERENT (also valid) bytes must be skipped, not overwrite.
  const other = validPngBytes(64);
  const res2 = await handle(putPng(key, other), env);
  assert.equal(res2.status, 200);
  assert.deepEqual(await res2.json(), { skipped: true });

  // The store still holds the ORIGINAL bytes.
  const stored = env.BUCKET._store.get(key);
  assert.deepEqual([...stored], [...bytes]);
});

test("GET /img/<key> returns the stored bytes with image/png + immutable cache", async () => {
  const env = { BUCKET: makeBucket() };
  const key = "position-xyz";
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 42, 7]);
  await env.BUCKET.put(key, bytes);

  const res = await handle(req("GET", "/img/" + key + ".png"), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.match(res.headers.get("cache-control") || "", /immutable/);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");

  const out = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...out], [...bytes]);
});

test("GET /img/<missing>.png returns a 200 placeholder PNG with a short cache", async () => {
  const env = { BUCKET: makeBucket() };
  const res = await handle(req("GET", "/img/never-uploaded.png"), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.match(res.headers.get("cache-control") || "", /max-age=60/);
  const out = new Uint8Array(await res.arrayBuffer());
  // Valid PNG signature (89 50 4E 47 0D 0A 1A 0A).
  assert.deepEqual([...out.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(out.byteLength > 8, "placeholder has body");
});

test("invalid image key => 400 (before touching R2)", async () => {
  const env = { BUCKET: makeBucket() };
  // A slash in the key (path traversal attempt) fails the charset gate.
  // Note: encode it so the URL path keeps the raw key segment intact.
  const res = await handle(
    req("GET", "/img/" + encodeURIComponent("../secret") + ".png"),
    env,
  );
  assert.equal(res.status, 400);
});

test("PUT with wrong content-type => 400", async () => {
  const env = { BUCKET: makeBucket() };
  const res = await handle(
    req("PUT", "/img/goodkey.png", {
      headers: { "content-type": "text/plain" },
      body: new Uint8Array([1, 2, 3]),
    }),
    env,
  );
  assert.equal(res.status, 400);
});

test("PUT with oversized body => 413 via the content-length pre-check", async () => {
  const env = { BUCKET: makeBucket() };
  const big = new Uint8Array(262144); // == MAX (rejected: must be < MAX)
  const res = await handle(putPng("bigkey", big), env);
  assert.equal(res.status, 413);
  assert.equal(env.BUCKET._store.size, 0, "nothing stored");
});

test("PUT with a lying (small) content-length still 413s on actual size", async () => {
  const env = { BUCKET: makeBucket() };
  // Declared 100 bytes, actual body == MAX: the post-read check must catch it.
  const big = new Uint8Array(262144);
  const res = await handle(putPng("liar", big, { "content-length": "100" }), env);
  assert.equal(res.status, 413);
  assert.equal(env.BUCKET._store.size, 0, "nothing stored");
});

test("PUT without a content-length header => 411", async () => {
  const env = { BUCKET: makeBucket() };
  const res = await handle(
    req("PUT", "/img/nolength.png", {
      headers: { "content-type": "image/png" },
      body: validPngBytes(),
    }),
    env,
  );
  assert.equal(res.status, 411);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("PUT with non-PNG bytes (claimed image/png) => 415, nothing stored", async () => {
  const env = { BUCKET: makeBucket() };
  // Claimed PNG but the bytes are not: must be rejected BEFORE reaching R2,
  // since first-write-wins + immutable caching would pin the poison forever.
  const junk = new Uint8Array(64).fill(0x41); // "AAAA..."
  const res = await handle(putPng("poison", junk), env);
  assert.equal(res.status, 415);
  assert.equal(env.BUCKET._store.size, 0, "poison bytes must not be stored");

  // Valid signature but absurd dimensions is rejected too.
  const huge = validPngBytes(4096); // > 2048 px
  const res2 = await handle(putPng("huge", huge), env);
  assert.equal(res2.status, 415);
  assert.equal(env.BUCKET._store.size, 0, "oversized-dimension png rejected");
});

test("OPTIONS preflight returns CORS headers", async () => {
  const env = { BUCKET: makeBucket() };
  const res = await handle(req("OPTIONS", "/img/anything.png"), env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-methods") || "", /PUT/);
  assert.match(
    res.headers.get("access-control-allow-headers") || "",
    /content-type/,
  );
});
