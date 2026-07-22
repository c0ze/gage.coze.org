// Node test for the Worker's PNG upload validator (worker/src/png.js).
// Run: node worker/png.test.mjs        (or: node png.test.mjs from worker/)
//
// Plain node — no framework. Same assert + "ok - ..." console pattern as the
// src/**/*.test.js suites. The module under test is pure (bytes in, verdict
// out), so tests just hand-construct byte buffers:
//   - a valid minimal PNG (signature + a correct IHDR for 316x316) -> accepted
//     with the right parsed width/height
//   - wrong magic, truncated buffers, a bad IHDR length, a non-IHDR first
//     chunk, and out-of-range dimensions (0 / >2048 / <8) -> all rejected
//   - bounds are inclusive: 8x8 and 2048x2048 are accepted

import assert from "node:assert";
import { validatePng } from "./src/png.js";

// ---------------------------------------------------------------------------
// Byte-buffer builders
// ---------------------------------------------------------------------------

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function u32be(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

// Build the head of a PNG: signature + IHDR chunk (length, type, 13 data
// bytes, 4 CRC filler bytes — the validator doesn't check CRCs). Options let
// individual tests corrupt one field at a time.
function pngHead({
  width = 316,
  height = 316,
  ihdrLength = 13,
  type = "IHDR",
  signature = SIGNATURE,
} = {}) {
  const typeBytes = [...type].map((c) => c.charCodeAt(0));
  return new Uint8Array([
    ...signature,
    ...u32be(ihdrLength),
    ...typeBytes,
    ...u32be(width),
    ...u32be(height),
    8, // bit depth
    6, // color type (RGBA)
    0, // compression
    0, // filter
    0, // interlace
    0, 0, 0, 0, // CRC (unchecked)
  ]);
}

// ---------------------------------------------------------------------------
// 1. Valid minimal PNG accepted, with correct parsed dimensions
// ---------------------------------------------------------------------------
{
  const res = validatePng(pngHead({ width: 316, height: 316 }));
  assert.strictEqual(res.ok, true, "valid 316x316 head must be accepted");
  assert.strictEqual(res.width, 316);
  assert.strictEqual(res.height, 316);
  assert.strictEqual(res.reason, "");
  console.log("ok - valid minimal PNG (316x316) accepted with parsed dimensions");
}

// A REAL complete PNG for good measure: the Worker's own 2x2 fallback tile is
// a genuine PNG but its dimensions are below the 8px floor -> rejected. This
// pins that the floor applies to real files, not just synthetic heads.
{
  const fallbackB64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR42mMomxYGRAwQCgAnRgWJ/PFUxAAAAABJRU5ErkJggg==";
  const bytes = new Uint8Array(Buffer.from(fallbackB64, "base64"));
  const res = validatePng(bytes);
  assert.strictEqual(res.ok, false, "2x2 real PNG is below the 8px floor");
  assert.strictEqual(res.reason, "dimensions out of range");
  console.log("ok - real 2x2 PNG parses but is rejected by the dimension floor");
}

// ---------------------------------------------------------------------------
// 2. Wrong magic rejected
// ---------------------------------------------------------------------------
{
  const badSig = [...SIGNATURE];
  badSig[0] = 0x88; // flip the first byte
  const res = validatePng(pngHead({ signature: badSig }));
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "bad png signature");

  // JPEG magic dressed up to the same length must also fail.
  const jpeg = pngHead();
  jpeg.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46], 0);
  const res2 = validatePng(jpeg);
  assert.strictEqual(res2.ok, false);
  assert.strictEqual(res2.reason, "bad png signature");
  console.log("ok - wrong magic rejected (flipped byte + JPEG magic)");
}

// ---------------------------------------------------------------------------
// 3. Truncated buffers rejected (never throws)
// ---------------------------------------------------------------------------
{
  const full = pngHead();
  for (const len of [0, 1, 7, 8, 12, 16, 23]) {
    const res = validatePng(full.slice(0, len));
    assert.strictEqual(res.ok, false, `truncated at ${len} must be rejected`);
    assert.strictEqual(res.reason, "too short");
  }
  // 24 bytes is exactly enough to read through height -> accepted.
  assert.strictEqual(validatePng(full.slice(0, 24)).ok, true);
  console.log("ok - truncated buffers rejected at every short length");
}

// ---------------------------------------------------------------------------
// 4. IHDR chunk-header corruption rejected
// ---------------------------------------------------------------------------
{
  const res = validatePng(pngHead({ ihdrLength: 12 }));
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "bad IHDR length");

  const res2 = validatePng(pngHead({ ihdrLength: 14 }));
  assert.strictEqual(res2.ok, false);
  assert.strictEqual(res2.reason, "bad IHDR length");

  const res3 = validatePng(pngHead({ type: "IDAT" }));
  assert.strictEqual(res3.ok, false);
  assert.strictEqual(res3.reason, "first chunk is not IHDR");
  console.log("ok - IHDR length != 13 and non-IHDR first chunk rejected");
}

// ---------------------------------------------------------------------------
// 5. Dimension bounds: 0 and >2048 rejected; 8..2048 inclusive accepted
// ---------------------------------------------------------------------------
{
  for (const [w, h] of [
    [0, 316],
    [316, 0],
    [0, 0],
    [2049, 316],
    [316, 2049],
    [7, 316], // below the 8px floor
    [316, 7],
    [0xffffffff, 316], // top bit set — must not go negative via 32-bit math
  ]) {
    const res = validatePng(pngHead({ width: w, height: h }));
    assert.strictEqual(res.ok, false, `${w}x${h} must be rejected`);
    assert.strictEqual(res.reason, "dimensions out of range");
  }

  for (const [w, h] of [
    [8, 8],
    [2048, 2048],
    [8, 2048],
    [316, 316],
  ]) {
    const res = validatePng(pngHead({ width: w, height: h }));
    assert.strictEqual(res.ok, true, `${w}x${h} must be accepted`);
    assert.strictEqual(res.width, w);
    assert.strictEqual(res.height, h);
  }
  console.log("ok - dimension bounds enforced (0 / 7 / 2049 / 2^32-1 out, 8..2048 in)");
}

// ---------------------------------------------------------------------------
// 6. Non-buffer inputs rejected, never thrown
// ---------------------------------------------------------------------------
{
  for (const bad of [null, undefined, "png", 42, {}, [], new ArrayBuffer(64)]) {
    const res = validatePng(bad);
    assert.strictEqual(res.ok, false, "non-Uint8Array input must be rejected");
  }
  console.log("ok - non-Uint8Array inputs rejected without throwing");
}

console.log("\nAll png.js validator tests passed.");
