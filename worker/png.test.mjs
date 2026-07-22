// Node test for the Worker's PNG upload validator (worker/src/png.js).
// Run: node worker/png.test.mjs
//
// The validator is a STRUCTURAL gate against poisoning the first-write-wins,
// immutable-cached /img store: signature + complete IHDR (fields + CRC) + a
// full chunk-framing walk requiring >=1 IDAT and a terminal zero-length IEND.
// These tests build REAL PNGs (png-fixture.mjs: zlib IDAT, computed CRCs) and
// then break them one property at a time — the old validator accepted a
// 24-byte header stub, which is now the FIRST thing asserted rejected.
import assert from "node:assert";
import { validatePng } from "./src/png.js";
import { buildPng } from "./png-fixture.mjs";

let passed = 0;
function ok(name) {
  passed++;
  console.log("ok - " + name);
}

// ---- 1. a real PNG is accepted, with parsed dimensions ---------------------
{
  const res = validatePng(buildPng({ width: 316, height: 316 }));
  assert.strictEqual(res.ok, true, "real 316x316 PNG must be accepted: " + res.reason);
  assert.strictEqual(res.width, 316);
  assert.strictEqual(res.height, 316);
  ok("real 316x316 PNG accepted with parsed dimensions");
}

// ---- 2. header-only stubs are REJECTED (the old validator's gap) -----------
{
  const full = buildPng({ width: 316, height: 316 });
  // 24 bytes = signature + IHDR length/type/width/height only.
  assert.strictEqual(validatePng(full.slice(0, 24)).ok, false, "24-byte stub");
  // 33 bytes = through the IHDR CRC, but no chunks after — still not a PNG.
  const head = validatePng(full.slice(0, 33));
  assert.strictEqual(head.ok, false, "33-byte IHDR-only stub");
  assert.strictEqual(head.reason, "truncated chunk");
  ok("header-only stubs rejected (24B and 33B)");
}

// ---- 3. wrong magic rejected ------------------------------------------------
{
  const bytes = buildPng({});
  bytes[0] = 0xff;
  assert.strictEqual(validatePng(bytes).reason, "bad png signature");
  const jpeg = new Uint8Array(64).fill(0x11);
  jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
  assert.strictEqual(validatePng(jpeg).reason, "bad png signature");
  ok("wrong magic (tampered + JPEG) rejected");
}

// ---- 4. truncation anywhere rejected ----------------------------------------
{
  const full = buildPng({ width: 8, height: 8 });
  for (const len of [0, 7, 8, 20, 32, full.length - 5, full.length - 1]) {
    assert.strictEqual(validatePng(full.slice(0, len)).ok, false, "len " + len);
  }
  ok("truncated buffers rejected at every boundary probed");
}

// ---- 5. IHDR corruption rejected ---------------------------------------------
{
  // bad declared IHDR length
  const a = buildPng({});
  a[11] = 12; // length 13 -> 12
  assert.strictEqual(validatePng(a).reason, "bad IHDR length");
  // first chunk not IHDR
  const b = buildPng({});
  b[12] = 0x58; // 'I' -> 'X'
  assert.strictEqual(validatePng(b).reason, "first chunk is not IHDR");
  // CRC broken by flipping a data byte WITHOUT recomputing the CRC
  const c = buildPng({});
  c[24] = 16; // bit depth 8 -> 16 (still legal for colour type 6) — CRC now stale
  assert.strictEqual(validatePng(c).reason, "bad IHDR crc");
  ok("IHDR corruption (length, type, stale CRC) rejected");
}

// ---- 6. dimension bounds ------------------------------------------------------
{
  assert.strictEqual(validatePng(buildPng({ width: 7, height: 316 })).reason, "dimensions out of range");
  assert.strictEqual(validatePng(buildPng({ width: 316, height: 2049 })).reason, "dimensions out of range");
  assert.strictEqual(validatePng(buildPng({ width: 8, height: 8 })).ok, true, "8x8 boundary accepted");
  assert.strictEqual(validatePng(buildPng({ width: 2048, height: 8 })).ok, true, "2048 boundary accepted");
  ok("dimension bounds enforced (7 / 2049 rejected; 8 / 2048 accepted)");
}

// ---- 7. illegal IHDR field rejected even with a CORRECT CRC --------------------
{
  const bytes = buildPng({});
  bytes[28] = 2; // interlace 0 -> 2 (illegal)
  // Recompute the IHDR CRC over [12..28] so the CRC check passes and the
  // FIELD check is what rejects.
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let x = n;
    for (let k = 0; k < 8; k++) x = x & 1 ? 0xedb88320 ^ (x >>> 1) : x >>> 1;
    table[n] = x >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 12; i < 29; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  bytes[29] = (crc >>> 24) & 0xff;
  bytes[30] = (crc >>> 16) & 0xff;
  bytes[31] = (crc >>> 8) & 0xff;
  bytes[32] = crc & 0xff;
  assert.strictEqual(validatePng(bytes).reason, "bad interlace method");
  ok("illegal IHDR field (interlace 2) rejected past a correct CRC");
}

// ---- 8. chunk-framing: no IDAT / data after IEND -------------------------------
{
  const full = buildPng({ width: 8, height: 8 });
  const iend = full.slice(full.length - 12); // IEND is always the last 12 bytes
  const noIdat = new Uint8Array([...full.slice(0, 33), ...iend]);
  assert.strictEqual(validatePng(noIdat).reason, "no IDAT data");
  const trailing = new Uint8Array([...full, 0x00]);
  assert.strictEqual(validatePng(trailing).reason, "data after IEND");
  ok("chunk framing enforced (no IDAT; trailing bytes after IEND)");
}

// ---- 9. non-buffer inputs rejected without throwing -----------------------------
{
  for (const bad of [null, undefined, "png", 42, {}, [], new ArrayBuffer(64)]) {
    const res = validatePng(bad);
    assert.strictEqual(res.ok, false);
  }
  ok("non-Uint8Array inputs rejected without throwing");
}

// ---- 10. zero-length IDAT rejected (57-byte stub can't poison a key) -----------
{
  const full = buildPng({ width: 8, height: 8 });
  const iend = full.slice(full.length - 12);
  // signature+IHDR (33) + an EMPTY IDAT chunk (len 0, type, CRC of "IDAT") + IEND
  const t = [0x49, 0x44, 0x41, 0x54];
  let table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let x = n;
    for (let k = 0; k < 8; k++) x = x & 1 ? 0xedb88320 ^ (x >>> 1) : x >>> 1;
    table[n] = x >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of t) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  const emptyIdat = [0, 0, 0, 0, ...t, (crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff];
  const stub = new Uint8Array([...full.slice(0, 33), ...emptyIdat, ...iend]);
  assert.strictEqual(validatePng(stub).reason, "no IDAT data");
  ok("zero-length IDAT stub rejected (cumulative IDAT payload must be positive)");
}

console.log("\nAll png.js validator tests passed (" + passed + " checks).");
