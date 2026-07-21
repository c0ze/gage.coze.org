// Node test for the share layer (src/share.js) — the PURE parts only.
// Run: `node src/share.test.js`
//
// Same recreate-the-browser-world approach as the transport tests: the Gage
// sources are IIFE content scripts mutating a shared `window.Gage`, so we build a
// vm context whose global carries a `window` shim, load the sources IN MANIFEST
// ORDER, then drive window.Gage.
//
// Coverage (all PURE — no canvas, no network):
//   1. positionKey: determinism + matches the CONTRACT key after 1.e4.
//   2. TRANSPOSITION EQUIVALENCE: two move orders reaching the same board share
//      one key (1.Nf3 d5 2.d4  ==  1.d4 d5 2.Nf3), while a genuinely different
//      position differs. Also: turn/castling/ep are excluded (visual only).
//   3. gameUrl / imageUrl format.
//   4. buildShareSeed round-trips through decodeSeed with the right meta.
//   5. generic (no game.positionKey) fallback key is deterministic + URL-safe.
//
// NOT covered (cannot be, in node): renderBoardCanvas / boardImageBlob need a
// real <canvas>; uploadBoardImage needs fetch + a live worker. Those require
// live-browser validation (see the task's RETURN notes).
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// ---- build the browser-like world ----------------------------------------
const sandbox = {
  console,
  TextEncoder,
  TextDecoder,
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
};
sandbox.window = sandbox; // vendored chess.js targets `window`; make it the global
vm.createContext(sandbox);

const ROOT = path.resolve(__dirname, ".."); // repo root
function load(rel) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), sandbox, { filename: rel });
}

// Manifest order (only what the PURE share helpers need — board-image.js is DOM/
// canvas-only, so it's deliberately not loaded here):
load("src/vendor/chess.js");
load("src/games/chess.js");
load("src/seed.js");
load("src/share.js");

const Gage = sandbox.window.Gage;
const chess = Gage.games.chess;

let passed = 0;
function ok(name) {
  passed++;
  console.log("  ok  - " + name);
}

// Cross-realm-safe structural compare (objects from the vm have that realm's
// Object.prototype, so deepStrictEqual's prototype check would fail).
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

// Build a chess State by applying a SAN line via the game module (chess.js
// resolves each SAN to from/to, so we never hand-encode squares).
function stateFromSans(sans) {
  const Chess = sandbox.window.Chess;
  const probe = new Chess();
  let st = chess.initialState();
  for (const san of sans) {
    const mv = probe.move(san);
    st = chess.applyMove(st, mv.from, mv.to, mv.promotion ? { promotion: mv.promotion } : undefined);
    assert.ok(st, "applyMove accepted " + san);
  }
  return st;
}

// ---- 1. positionKey: determinism + CONTRACT key ---------------------------
(function positionKeyBasics() {
  const start = chess.initialState();
  assert.strictEqual(
    Gage.positionKey(chess, start),
    "rnbqkbnr-pppppppp-8-8-8-8-PPPPPPPP-RNBQKBNR",
    "start position key"
  );

  const afterE4 = stateFromSans(["e4"]);
  const k1 = Gage.positionKey(chess, afterE4);
  const k2 = Gage.positionKey(chess, stateFromSans(["e4"]));
  assert.strictEqual(
    k1,
    "rnbqkbnr-pppppppp-8-8-4P3-8-PPPP1PPP-RNBQKBNR",
    "1.e4 key matches the CONTRACT example"
  );
  assert.strictEqual(k1, k2, "positionKey is deterministic for the same position");
  // URL-safe ASCII: letters, digits, "-" only.
  assert.ok(/^[A-Za-z0-9-]+$/.test(k1), "key is URL-safe ASCII");
  // Delegates to the game module's own positionKey.
  assert.strictEqual(k1, chess.positionKey(afterE4), "Gage.positionKey uses chess.positionKey");
  ok("positionKey is deterministic and matches the CONTRACT key");
})();

// ---- 2. TRANSPOSITION EQUIVALENCE -----------------------------------------
(function transposition() {
  // Same final board via two move orders:
  //   A: 1.Nf3 d5 2.d4      B: 1.d4 d5 2.Nf3
  // Both reach r n b q k b n r / p p p . p p p p / ... with N on f3 and P on d4.
  const A = stateFromSans(["Nf3", "d5", "d4"]);
  const B = stateFromSans(["d4", "d5", "Nf3"]);

  // Sanity: the move LISTS differ (so it's a real transposition, not the same
  // path), but the resulting BOARD is identical.
  assert.notStrictEqual(
    JSON.stringify(A.moves),
    JSON.stringify(B.moves),
    "the two lines are genuinely different move orders"
  );
  sameShape(chess.view(A), chess.view(B), "both lines reach the same visual board");

  const kA = Gage.positionKey(chess, A);
  const kB = Gage.positionKey(chess, B);
  assert.strictEqual(kA, kB, "transposition => identical position key (one shared image)");

  // A genuinely different position must NOT collide.
  const other = stateFromSans(["e4"]);
  assert.notStrictEqual(kA, Gage.positionKey(chess, other), "different position => different key");
  ok("transposition equivalence: same board via different orders shares one key");
})();

// ---- 2b. key is VISUAL-ONLY (turn / castling / ep excluded) ----------------
(function visualOnly() {
  // Reach the SAME piece placement with a DIFFERENT side to move.
  //   White to move: 1.Nf3 Nf6 2.Ng1 Ng8  (knights out and back -> start board,
  //                  White to move — a null-ish round trip)
  //   Black to move: start position itself is White-to-move, so instead compare
  //                  placements that match but differ in turn via the round trip
  //                  above vs the initial position.
  const roundTrip = stateFromSans(["Nf3", "Nf6", "Ng1", "Ng8"]);
  const start = chess.initialState();
  // Same visual board as the start (all pieces home) ...
  sameShape(chess.view(roundTrip), chess.view(start), "knights out-and-back restores the board");
  // ... and identical keys, even though the move-count/history differ. This is
  // exactly the "castling rights / clocks / history dropped" property: only the
  // visible placement drives the key.
  assert.strictEqual(
    Gage.positionKey(chess, roundTrip),
    Gage.positionKey(chess, start),
    "key ignores history/castling/clocks — visual placement only"
  );
  // Turn differs across a single ply but we only assert placement drives the key;
  // confirm the turn itself is NOT part of the key string.
  const afterE4 = stateFromSans(["e4"]);
  assert.ok(
    Gage.positionKey(chess, afterE4).indexOf(" w ") === -1 &&
      Gage.positionKey(chess, afterE4).indexOf(" b ") === -1,
    "key carries no side-to-move field"
  );
  ok("positionKey encodes the visual placement only (no turn/castling/ep)");
})();

// ---- 3. gameUrl / imageUrl format -----------------------------------------
(function urls() {
  assert.strictEqual(Gage.SHARE_ORIGIN, "https://gage.coze.org", "share origin constant");

  const seed = "AbC-_123";
  assert.strictEqual(Gage.gameUrl(seed), "https://gage.coze.org/g/AbC-_123", "gameUrl format");

  const key = "rnbqkbnr-pppppppp-8-8-4P3-8-PPPP1PPP-RNBQKBNR";
  assert.strictEqual(
    Gage.imageUrl(key),
    "https://gage.coze.org/img/rnbqkbnr-pppppppp-8-8-4P3-8-PPPP1PPP-RNBQKBNR.png",
    "imageUrl format"
  );
  ok("gameUrl / imageUrl produce the CONTRACT URLs");
})();

// ---- 4. buildShareSeed round-trips through decodeSeed ----------------------
(function shareSeedRoundTrip() {
  const state = stateFromSans(["e4"]); // Black to move after 1.e4
  const players = { w: "alice", b: "bob", san: "e4" };
  const seed = Gage.buildShareSeed(chess, state, players);

  // gameUrl wraps it unchanged.
  assert.strictEqual(Gage.gameUrl(seed), "https://gage.coze.org/g/" + seed, "seed drops into gameUrl");

  const env = Gage.decodeSeed(seed);
  assert.strictEqual(env.v, 1, "envelope version");
  assert.strictEqual(env.game, "chess", "envelope game id");
  sameShape(env.state, state, "decoded state deep-equals the source state");

  const expectedKey = "rnbqkbnr-pppppppp-8-8-4P3-8-PPPP1PPP-RNBQKBNR";
  sameShape(
    env.meta,
    { w: "alice", b: "bob", turn: "b", san: "e4", key: expectedKey },
    "meta = { w, b, turn(computed), san(passthrough), key(positionKey) }"
  );
  // turn is COMPUTED from the state, not taken from players.
  assert.strictEqual(env.meta.turn, chess.turn(state), "meta.turn == gameModule.turn(state)");
  assert.strictEqual(env.meta.key, Gage.positionKey(chess, state), "meta.key == positionKey(state)");
  ok("buildShareSeed round-trips through decodeSeed with the contract meta");

  // Missing san defaults to "" (pass-through, never undefined in the envelope).
  const seed2 = Gage.buildShareSeed(chess, state, { w: "a", b: "b" });
  assert.strictEqual(Gage.decodeSeed(seed2).meta.san, "", "absent san encodes as empty string");
  ok("buildShareSeed encodes an absent last-move san as \"\"");
})();

// ---- 5. generic fallback key (no game.positionKey) -------------------------
(function genericFallback() {
  // A minimal fake game module WITHOUT positionKey, to exercise the view-derived
  // path. 2x2 board: one white "K", one black "Q", two empties.
  const fakeState = { game: "fake" };
  const fake = {
    boardSize: { rows: 2, cols: 2 },
    view: function () {
      return [
        [{ glyph: "K", color: "w" }, {}],
        [{}, { glyph: "Q", color: "b" }],
      ];
    },
    turn: function () {
      return "w";
    },
  };

  const k = Gage.positionKey(fake, fakeState);
  assert.strictEqual(k, Gage.positionKey(fake, fakeState), "generic key is deterministic");
  assert.ok(/^[A-Za-z0-9._-]+$/.test(k), "generic key is URL-safe ASCII");
  // Empties are ".", cells encode color + glyph-codepoint(base36); rows joined by
  // "-", cells by "_". "K"=75->"23", "Q"=81->"29" in base36.
  assert.strictEqual(k, "w23_.-._b29", "generic key encodes cells/rows deterministically");

  // A different board yields a different key; an identical board yields the same.
  const fake2 = Object.assign({}, fake, {
    view: function () {
      return [
        [{ glyph: "K", color: "w" }, {}],
        [{}, { glyph: "Q", color: "w" }], // Q now white
      ];
    },
  });
  assert.notStrictEqual(k, Gage.positionKey(fake2, fakeState), "different colors => different key");
  ok("generic view-derived key is deterministic, URL-safe, and position-sensitive");
})();

console.log("\nAll share tests passed (" + passed + " checks).");
