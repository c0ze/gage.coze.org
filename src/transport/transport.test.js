// Node test for the transport layer. Run: `node src/transport/transport.test.js`
//
// The Gage sources are classic content scripts (IIFEs mutating a shared
// `window.Gage`), not modules. We recreate that browser world with a vm context
// whose global carries a `window` shim, load the needed sources IN MANIFEST
// ORDER, then drive the resulting window.Gage API. Same pattern the extension
// relies on in the page.
//
// Coverage:
//   1. formatMove -> parseMove round-trips (challenge + reply), moveText + gameId.
//   2. reconstruct over a valid SAN line == applying the same SAN via applyMove.
//   3. an illegal SAN mid-sequence is reported via `error` (not silently dropped).
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// ---- build the browser-like world ----------------------------------------
// btoa/atob exist on modern Node globals; pass them through for seed.js.
const sandbox = {
  console,
  TextEncoder,
  TextDecoder,
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
};
sandbox.window = sandbox; // vendored chess.js targets `window`; make it the global
vm.createContext(sandbox);

const ROOT = path.resolve(__dirname, "..", ".."); // repo root
function load(rel) {
  const file = path.join(ROOT, rel);
  vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: rel });
}

// Manifest order (only what the transport needs):
load("src/vendor/chess.js");
load("src/games/chess.js");
load("src/seed.js");
load("src/transport/protocol.js");
load("src/transport/reconstruct.js");

const Gage = sandbox.window.Gage;
const chess = Gage.games.chess;
const { protocol, reconstruct } = Gage;

let passed = 0;
function ok(name) {
  passed++;
  console.log("  ok  - " + name);
}

// Objects returned by code running inside the vm context have that context's
// Object.prototype, so deepStrictEqual's prototype check fails cross-realm even
// when values match. Compare by structural value instead (order-independent).
function sameShape(actual, expected, msg) {
  assert.strictEqual(JSON.stringify(sortKeys(actual)), JSON.stringify(sortKeys(expected)), msg);
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

// ---- 1. formatMove / parseMove round-trip ---------------------------------
(function roundTrip() {
  // Challenge (root) carries the game tag + move 1.
  const challenge = protocol.formatMove({
    gameId: "chess",
    moveText: "e4",
    opponentHandle: "rival",
    isChallenge: true,
  });
  assert.ok(challenge.includes(protocol.MARKER), "challenge has marker");
  assert.ok(challenge.includes("[e4]"), "challenge has move slot");
  assert.ok(challenge.includes("@rival"), "challenge mentions opponent");
  const pc = protocol.parseMove(challenge);
  sameShape(pc, { moveText: "e4", gameId: "chess" }, "challenge parses to move + gameId");
  ok("formatMove/parseMove round-trips a challenge (move + gameId)");

  // Reply is terse: move + marker, no game tag.
  const reply = protocol.formatMove({ moveText: "Nf6", isChallenge: false });
  assert.ok(reply.includes(protocol.MARKER), "reply has marker");
  const pr = protocol.parseMove(reply);
  sameShape(pr, { moveText: "Nf6" }, "reply parses to move, no gameId");
  ok("formatMove/parseMove round-trips a reply (move only, gameId inherited)");

  // Human-tolerant: prose, handles, extra hashtags around the slot still parse.
  const messy = "gg @rival trying this one 😅 #chessisfun [Qh7#] #gage #chess";
  const pm = protocol.parseMove(messy);
  assert.strictEqual(pm.moveText, "Qh7#", "extracts SAN with # from prose");
  assert.strictEqual(pm.gameId, "chess", "detects #chess amid noise, skips #chessisfun");
  ok("parseMove tolerates surrounding human text / handles / hashtags");

  // Non-Gage tweet -> null. Marker-but-no-slot -> null (thread chatter).
  assert.strictEqual(protocol.parseMove("just a normal tweet [e4]"), null, "no marker -> null");
  assert.strictEqual(protocol.parseMove("nice game! #gage"), null, "marker but no slot -> null");
  assert.strictEqual(protocol.parseMove("look #gagexyz [e4]"), null, "#gagexyz is not the marker");
  ok("parseMove returns null for non-move / non-Gage tweets");

  // A valid #gage AFTER a decoy #gagexyz must still be detected (not only the
  // first "#gage" occurrence).
  sameShape(
    protocol.parseMove("heads up #gagexyz — anyway #gage [e4]"),
    { moveText: "e4" },
    "late #gage after a #gagexyz decoy is detected"
  );
  ok("parseMove finds a standalone #gage even after a #gagexyz decoy");
})();

// ---- 2. reconstruct(valid SAN) == applyMove path --------------------------
(function reconstructMatchesApplyMove() {
  // A real opening incl. a capture and castling, to exercise SAN variety.
  const sans = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O", "Be7"];

  // Ground truth: build the same line via from/to applyMove (chess.js resolves
  // each SAN to from/to for us so the reference doesn't hand-encode squares).
  const ref = (function buildViaApplyMove() {
    let st = chess.initialState();
    const Chess = sandbox.window.Chess;
    const probe = new Chess();
    for (const san of sans) {
      const mv = probe.move(san); // resolve SAN -> {from,to,promotion?}
      st = chess.applyMove(st, mv.from, mv.to, mv.promotion ? { promotion: mv.promotion } : undefined);
      assert.ok(st, "applyMove accepted " + san);
    }
    return st;
  })();

  const r = reconstruct(chess, sans);
  assert.strictEqual(r.error, null, "valid line reconstructs with no error");
  assert.strictEqual(r.moveCount, sans.length, "all moves applied");
  sameShape(r.state, ref, "reconstruct State deep-equals the applyMove State");
  // And the seed (the thing transport-adjacent code hashes/compares) matches.
  assert.strictEqual(
    Gage.encodeSeed(r.state),
    Gage.encodeSeed(ref),
    "reconstruct seed == applyMove seed"
  );
  ok("reconstruct over a valid SAN line equals the applyMove-built State");
})();

// ---- 3. illegal SAN mid-sequence is reported via error --------------------
(function illegalMoveIsReported() {
  // Legal, legal, then an illegal move, then a move that would be legal on its
  // own — the illegal one must stop the walk before the fourth is reached.
  // After 1.e4 e5 it's White to move; "Bb4" is unreachable (no bishop can get
  // to b4), so chess.js rejects it.
  const sans = ["e4", "e5", "Bb4", "Nf3"];
  const r = reconstruct(chess, sans);
  assert.ok(r.error, "an error is reported");
  assert.strictEqual(r.error.index, 2, "error points at the first bad move (index 2)");
  assert.strictEqual(r.error.moveText, "Bb4", "error carries the offending SAN");
  assert.strictEqual(r.moveCount, 2, "only the moves before the bad one applied");
  // State is frozen at the last legal position (after e4 e5).
  const good = reconstruct(chess, ["e4", "e5"]);
  sameShape(r.state, good.state, "state stops at last legal position");
  ok("reconstruct reports the first illegal SAN via error and stops there");
})();

// ---- 4. non-move entries (null/blank chatter) are skipped, not fatal -------
(function skipsChatter() {
  const withGaps = reconstruct(chess, ["e4", null, "e5", "", "Nf3"]);
  assert.strictEqual(withGaps.error, null, "null/blank entries don't error");
  assert.strictEqual(withGaps.moveCount, 3, "only the 3 real moves counted");
  const clean = reconstruct(chess, ["e4", "e5", "Nf3"]);
  sameShape(withGaps.state, clean.state, "skipping chatter == the gapless line");
  ok("reconstruct skips null/blank chatter entries instead of erroring");
})();

console.log("\nAll transport tests passed (" + passed + " checks).");
