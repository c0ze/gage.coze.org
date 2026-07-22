// Shared test fixture: build a REAL, structurally complete PNG in pure node
// (zlib for IDAT) so tests exercise the Worker's full validator — signature,
// IHDR with a correct CRC, at least one IDAT, and a terminal IEND. Used by
// worker/png.test.mjs and worker/test/worker.test.mjs.
//
//   import { buildPng } from "../png-fixture.mjs";
//   const bytes = buildPng({ width: 316, height: 316 });   // Uint8Array
//
// The image is truecolour+alpha (colour type 6, bit depth 8) with zeroed
// scanlines — exactly the family canvas.toBlob emits — and every chunk CRC is
// computed for real, so tampering tests can corrupt specific bytes.
import zlib from "node:zlib";

function u32be(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

let TABLE = null;
function crc32(bytes) {
  if (!TABLE) {
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const t = [...type].map((c) => c.charCodeAt(0));
  const body = [...t, ...data];
  return [...u32be(data.length), ...body, ...u32be(crc32(body))];
}

export function buildPng({ width = 316, height = 316 } = {}) {
  const ihdrData = [
    ...u32be(width),
    ...u32be(height),
    8, // bit depth
    6, // colour type: truecolour + alpha
    0, // compression
    0, // filter
    0, // interlace
  ];
  // Raw image data: each scanline = 1 filter byte + width * 4 channel bytes.
  const raw = Buffer.alloc(height * (1 + width * 4)); // zeros: filter 0, black
  const idatData = [...zlib.deflateSync(raw)];
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
    ...chunk("IHDR", ihdrData),
    ...chunk("IDAT", idatData),
    ...chunk("IEND", []),
  ]);
}
