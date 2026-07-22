// PNG upload validation for the Gage board-card Worker.
// ======================================================
// PUT /img/<key>.png stores bytes under a predictable, position-derived key
// with first-write-wins + a 1-year immutable cache — so a poisoned first write
// would be pinned forever. Checking the CLAIMED content-type is not enough;
// this module checks the ACTUAL bytes before anything reaches R2.
//
// Scope: a structural gate, not a decoder — we never inflate IDAT. It verifies
//   1. the 8-byte PNG signature;
//   2. the complete IHDR chunk (spec-required first chunk): length 13, type,
//      sane dimensions (8..2048 per side), legal bit-depth/colour-type/
//      compression/filter/interlace fields, and a CORRECT CRC32 — so a
//      hand-typed 24-byte header stub no longer passes;
//   3. the chunk framing end to end: every chunk's declared length must fit
//      the buffer, at least one IDAT must exist, and the file must terminate
//      with a well-formed zero-length IEND with nothing after it.
// That rejects arbitrary-bytes smuggling, header-only stubs, and truncated
// files while staying dependency-free and O(chunks) — we read 12 bytes per
// chunk header, never chunk bodies.

// PNG signature: 0x89 'P' 'N' 'G' '\r' '\n' 0x1A '\n'.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// IHDR is fixed-length by spec: 13 data bytes.
const IHDR_LENGTH = 13;

// Sane bounds for a board image side. The extension renders ~316px boards;
// 2048 leaves headroom for retina renders, 8 rejects degenerate 1x1 tracking
// pixels and the like.
const MIN_DIMENSION = 8;
const MAX_DIMENSION = 2048;

// Signature (8) + IHDR: length (4) + type (4) + data (13) + CRC (4) = 33.
const MIN_PARSE_BYTES = 33;

// Chunk-walk backstop: a 256 KiB body can't legitimately need more chunks
// than this (IDAT is typically a handful of large chunks).
const MAX_CHUNKS = 4096;

// Read a 4-byte big-endian unsigned int from bytes at offset. PNG is
// big-endian throughout ("network byte order").
function readUint32BE(bytes, offset) {
  // >>> 0 keeps the result an unsigned 32-bit value (byte 0 can set the sign
  // bit under plain << arithmetic).
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

// CRC-32 (ISO 3309 / ITU-T V.42), as required by the PNG spec for each chunk
// (computed over the chunk TYPE + DATA, not the length). Table built lazily.
let CRC_TABLE = null;
function crc32(bytes, start, end) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Legal bit depths per colour type (PNG spec §11.2.2).
const DEPTHS_BY_COLOR_TYPE = {
  0: [1, 2, 4, 8, 16], // greyscale
  2: [8, 16], //           truecolour
  3: [1, 2, 4, 8], //      indexed
  4: [8, 16], //           greyscale + alpha
  6: [8, 16], //           truecolour + alpha (what canvas.toBlob emits)
};

// validatePng(bytes: Uint8Array) -> { ok, width, height, reason }
//   ok:     true iff the buffer is structurally a complete PNG (see header).
//   width/height: parsed dimensions when ok (0 otherwise).
//   reason: short machine-readable string when !ok ("" when ok).
// Pure and total: never throws, regardless of input.
export function validatePng(bytes) {
  const fail = (reason) => ({ ok: false, width: 0, height: 0, reason });

  if (!(bytes instanceof Uint8Array)) return fail("not a byte buffer");
  if (bytes.length < MIN_PARSE_BYTES) return fail("too short");

  // 1. Signature.
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return fail("bad png signature");
  }

  // 2. IHDR chunk. Layout after the signature (offset 8):
  //    [8..11]  chunk data length, 4-byte BE — must be 13 for IHDR
  //    [12..15] chunk type — must be ASCII "IHDR"
  //    [16..19] width,  4-byte BE
  //    [20..23] height, 4-byte BE
  //    [24]     bit depth   [25] colour type   [26] compression
  //    [27]     filter      [28] interlace
  //    [29..32] CRC32 over type+data ([12..28])
  const chunkLength = readUint32BE(bytes, 8);
  if (chunkLength !== IHDR_LENGTH) return fail("bad IHDR length");

  if (
    bytes[12] !== 0x49 || // I
    bytes[13] !== 0x48 || // H
    bytes[14] !== 0x44 || // D
    bytes[15] !== 0x52 //    R
  ) {
    return fail("first chunk is not IHDR");
  }

  const width = readUint32BE(bytes, 16);
  const height = readUint32BE(bytes, 20);
  if (
    width < MIN_DIMENSION ||
    width > MAX_DIMENSION ||
    height < MIN_DIMENSION ||
    height > MAX_DIMENSION
  ) {
    return fail("dimensions out of range");
  }

  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const legalDepths = DEPTHS_BY_COLOR_TYPE[colorType];
  if (!legalDepths || legalDepths.indexOf(bitDepth) === -1) {
    return fail("bad bit depth / colour type");
  }
  if (bytes[26] !== 0) return fail("bad compression method");
  if (bytes[27] !== 0) return fail("bad filter method");
  if (bytes[28] !== 0 && bytes[28] !== 1) return fail("bad interlace method");

  if (readUint32BE(bytes, 29) !== crc32(bytes, 12, 29)) {
    return fail("bad IHDR crc");
  }

  // 3. Chunk framing walk: every chunk must FIT, at least one IDAT must
  //    exist, and the buffer must end exactly at a zero-length IEND. We do
  //    NOT CRC or decode non-IHDR chunks — framing alone kills stubs and
  //    truncations, and a fully coherent malicious PNG is out of scope (that
  //    needs authenticated uploads; see the comment in index.js).
  let offset = 8 + 12 + IHDR_LENGTH; // first chunk after IHDR
  let idatBytes = 0; // cumulative IDAT payload — must be POSITIVE, not just present
  for (let n = 0; n < MAX_CHUNKS; n++) {
    if (offset + 12 > bytes.length) return fail("truncated chunk");
    const len = readUint32BE(bytes, offset);
    const t0 = bytes[offset + 4];
    const t1 = bytes[offset + 5];
    const t2 = bytes[offset + 6];
    const t3 = bytes[offset + 7];
    const end = offset + 12 + len;
    if (end > bytes.length) return fail("truncated chunk");
    // IEND: must be zero-length and the FINAL bytes of the buffer.
    if (t0 === 0x49 && t1 === 0x45 && t2 === 0x4e && t3 === 0x44) {
      if (len !== 0) return fail("bad IEND");
      if (end !== bytes.length) return fail("data after IEND");
      // A zero-length IDAT would satisfy a mere "saw IDAT" flag — a 57-byte
      // stub could then poison an immutable key. Real image data is non-empty.
      return idatBytes > 0
        ? { ok: true, width, height, reason: "" }
        : fail("no IDAT data");
    }
    if (t0 === 0x49 && t1 === 0x44 && t2 === 0x41 && t3 === 0x54) {
      idatBytes += len; // IDAT
    }
    offset = end;
  }
  return fail("too many chunks");
}
