// PNG upload validation for the Gage board-card Worker.
// ======================================================
// PUT /img/<key>.png stores bytes under a predictable, position-derived key
// with first-write-wins + a 1-year immutable cache — so a poisoned first write
// would be pinned forever. Checking the CLAIMED content-type is not enough;
// this module checks the ACTUAL bytes before anything reaches R2.
//
// Scope: this is a structural sanity gate, not a full PNG decoder. It verifies
//   1. the 8-byte PNG signature (0x89 'P' 'N' 'G' \r \n 0x1A \n), and
//   2. the IHDR chunk — which the PNG spec REQUIRES to be the first chunk
//      right after the signature: 4-byte big-endian length (must be 13),
//      4-byte type "IHDR", then 4-byte BE width and 4-byte BE height —
//      enforcing sane board dimensions (8..2048 px per side).
// That rejects arbitrary-bytes smuggling and absurd dimensions while staying
// dependency-free and O(1) (only the first 33 bytes are inspected).

// PNG signature: 0x89 'P' 'N' 'G' '\r' '\n' 0x1A '\n'.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// IHDR is fixed-length by spec: 13 data bytes.
const IHDR_LENGTH = 13;

// Sane bounds for a board image side. The extension renders ~316px boards;
// 2048 leaves headroom for retina renders, 8 rejects degenerate 1x1 tracking
// pixels and the like.
const MIN_DIMENSION = 8;
const MAX_DIMENSION = 2048;

// Minimum bytes we must be able to read: signature (8) + IHDR length (4) +
// IHDR type (4) + width (4) + height (4) = 24. (A real PNG is longer — bit
// depth, CRC, IDAT, IEND — but we only validate through the dimensions.)
const MIN_PARSE_BYTES = 24;

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

// validatePng(bytes: Uint8Array) -> { ok, width, height, reason }
//   ok:     true iff the buffer starts with a structurally valid PNG
//           signature + IHDR and the dimensions are within bounds.
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

  // 2. IHDR chunk header. Layout after the signature (offset 8):
  //    [8..11]  chunk data length, 4-byte BE — must be 13 for IHDR
  //    [12..15] chunk type — must be ASCII "IHDR"
  //    [16..19] width,  4-byte BE
  //    [20..23] height, 4-byte BE
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

  return { ok: true, width, height, reason: "" };
}
