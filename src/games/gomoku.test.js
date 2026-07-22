// Node test for the gomoku Game module (src/games/gomoku.js). PURE — no DOM, no
// network — so we recreate the browser world with a vm context (the same pattern
// as src/share.test.js and src/transport/orchestration.test.js): the Gage source
// is an IIFE content script mutating a shared `window.Gage`, so we build a vm
// context whose global carries a `window` shim, load the source, then drive
// window.Gage.games.gomoku.
//
// Coverage (all PURE):
//   1. empty setup: initialState, board, turn, boardSize, moveKind.
//   2. a place: applyMove appends, flips turn, doesn't mutate; illegal replays.
//   3. wins detected: horizontal, vertical, diagonal, anti-diagonal.
//   4. near-miss: 4-in-a-row is NOT over; overline (6) still wins.
//   5. applyMoveText <-> applyMove parity (byte-identical state).
//   6. positionKey: length <= 115, URL-safe, deterministic, visual-only.
//   7. a draw is representable (full board, no five).
//   8. no moves after terminal; mustPass is always false; legalMoves count.
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
sandbox.window = sandbox; // IIFE content scripts target `window`; make it the global
vm.createContext(sandbox);

const ROOT = path.resolve(__dirname, "..", ".."); // repo root
function load(rel) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), sandbox, { filename: rel });
}

load("src/games/gomoku.js");

const Gage = sandbox.window.Gage;
const g = Gage.games.gomoku;

let passed = 0;
function ok(name) {
  passed++;
  console.log("  ok  - " + name);
}

// Cross-realm-safe structural compare (objects from the vm have that realm's
// Object.prototype, so deepStrictEqual's prototype check would fail).
function sameShape(actual, expected, msg) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), msg);
}

// Apply a sequence of placement tokens through applyMove, asserting each is legal.
// from === to === token for a placement move.
function play(tokens) {
  let st = g.initialState();
  for (const t of tokens) {
    st = g.applyMove(st, t, t);
    assert.ok(st, "applyMove accepted " + t);
  }
  return st;
}

// ---- 1. empty setup --------------------------------------------------------
(function emptySetup() {
  const st = g.initialState();
  sameShape(st, { game: "gomoku", moves: [] }, "initialState is an empty gomoku state");
  assert.strictEqual(g.id, "gomoku", "id is gomoku");
  assert.strictEqual(g.moveKind, "place", "moveKind is place");
  sameShape(g.boardSize, { rows: 15, cols: 15 }, "boardSize is 15x15");
  assert.strictEqual(g.turn(st), "w", "White moves first");

  const cells = g.view(st);
  assert.strictEqual(cells.length, 15, "15 rows");
  assert.strictEqual(cells[0].length, 15, "15 cols");
  assert.ok(
    cells.every((row) => row.every((cell) => !cell.glyph)),
    "every cell is empty on a fresh board"
  );
  // squareAt: a15 top-left, o1 bottom-right.
  assert.strictEqual(g.squareAt(0, 0), "a15", "top-left is a15");
  assert.strictEqual(g.squareAt(14, 14), "o1", "bottom-right is o1");
  assert.strictEqual(g.squareAt(7, 7), "h8", "center is h8");

  assert.strictEqual(g.terminal(st).over, false, "fresh board is not terminal");
  assert.strictEqual(g.mustPass(st), false, "gomoku never passes");
  assert.strictEqual(g.legalMoves(st).length, 225, "225 empty intersections are legal");
  ok("empty setup: 15x15 empty board, White to move, 225 legal placements");
})();

// ---- 2. a place ------------------------------------------------------------
(function aPlace() {
  const st0 = g.initialState();
  const st1 = g.applyMove(st0, "h8", "h8");
  assert.ok(st1, "placing at h8 is legal");
  sameShape(st1.moves, ["h8"], "move list records the placement token");
  sameShape(st0.moves, [], "applyMove did not mutate the source state");
  assert.strictEqual(g.turn(st1), "b", "turn flipped to Black after White places");

  // The stone shows up in the view with the mover's color.
  const cells = g.view(st1);
  sameShape(cells[7][7], { glyph: "●", color: "w" }, "h8 shows a white stone");

  // legalMovesFrom: [sq] for an empty target, [] for an occupied one, [] for junk.
  sameShape(g.legalMovesFrom(st1, "a15"), ["a15"], "empty cell yields [sq]");
  sameShape(g.legalMovesFrom(st1, "h8"), [], "occupied cell yields []");
  sameShape(g.legalMovesFrom(st1, "z9"), [], "off-board token yields []");
  assert.strictEqual(g.legalMoves(st1).length, 224, "one fewer legal placement after a stone");

  // Illegal placements return null.
  assert.strictEqual(g.applyMove(st1, "h8", "h8"), null, "cannot place on an occupied cell");
  assert.strictEqual(g.applyMove(st1, "h8", "a15"), null, "from !== to is rejected");
  assert.strictEqual(g.applyMove(st1, "z9", "z9"), null, "off-board placement is rejected");
  ok("a place: appends token, flips turn, no mutation, rejects illegal placements");
})();

// ---- 3. wins detected (H / V / diagonal / anti-diagonal) -------------------
(function wins() {
  // Interleave White (winner) and Black (harmless, off the winning line) moves so
  // it is a real alternating game. White gets 5 in a row on the 9th ply.
  // Horizontal: White on rank 8, files d..h; Black parked up on rank 15.
  const H = play(["d8", "a15", "e8", "b15", "f8", "c15", "g8", "d15", "h8"]);
  assert.strictEqual(g.terminal(H).over, true, "horizontal five ends the game");
  assert.strictEqual(g.terminal(H).result, "w", "White made the horizontal five");

  // Vertical: White on file h, ranks 4..8.
  const V = play(["h4", "a15", "h5", "b15", "h6", "c15", "h7", "d15", "h8"]);
  assert.strictEqual(g.terminal(V).result, "w", "vertical five wins");

  // Diagonal (top-left -> bottom-right): d4,e5,f6,g7,h8.
  const D = play(["d4", "a15", "e5", "b15", "f6", "c15", "g7", "d15", "h8"]);
  assert.strictEqual(g.terminal(D).result, "w", "diagonal five wins");

  // Anti-diagonal (bottom-left -> top-right): d4,e3?? — use h4,g5,f6,e7,d8.
  const A = play(["h4", "a15", "g5", "b15", "f6", "c15", "e7", "d15", "d8"]);
  assert.strictEqual(g.terminal(A).result, "w", "anti-diagonal five wins");

  // The loser (Black) is never wrongly credited: result is always the mover.
  assert.strictEqual(g.turn(H), "b", "after White's winning move it would be Black's turn");
  ok("wins detected: horizontal, vertical, diagonal, and anti-diagonal fives");
})();

// ---- 4. near-miss (4) and overline (6) ------------------------------------
(function nearMissAndOverline() {
  // Four White stones in a row, alternating with harmless Black — NOT a win.
  const four = play(["d8", "a15", "e8", "b15", "f8", "c15", "g8"]);
  assert.strictEqual(g.terminal(four).over, false, "four in a row is not five");
  assert.strictEqual(g.legalMoves(four).length, 225 - 7, "game continues after a near-miss");

  // Overline of six (freestyle: 6+ still wins). A straight six always contains a
  // five, so to reach six WITHOUT a prior five triggering the win we leave a gap:
  // White places c8,d8,e8,g8,h8 (gap at f8 — never five), Black parked harmlessly,
  // then White's f8 connects c..h into a single run of six at once.
  const six = play(["c8", "a15", "d8", "c15", "e8", "e15", "g8", "g15", "h8", "i15", "f8"]);
  assert.strictEqual(g.terminal(six).over, true, "overline of six is terminal");
  assert.strictEqual(g.terminal(six).result, "w", "overline of six wins for White");
  ok("near-miss (4) is not over; overline (6) still wins (freestyle)");
})();

// ---- 5. applyMoveText <-> applyMove parity --------------------------------
(function textParity() {
  const line = ["h8", "h9", "g7", "g8", "f6"];
  let viaMove = g.initialState();
  let viaText = g.initialState();
  for (const t of line) {
    // moveText computed against the pre-move state equals the placement token.
    assert.strictEqual(g.moveText(viaMove, t, t), t, "moveText is the square token: " + t);
    viaMove = g.applyMove(viaMove, t, t);
    viaText = g.applyMoveText(viaText, t);
    assert.ok(viaText, "applyMoveText accepted " + t);
    // Byte-identical state at every step.
    sameShape(viaText, viaMove, "applyMoveText state == applyMove state after " + t);
  }
  // applyMoveText tolerates surrounding whitespace and rejects junk / occupied.
  sameShape(g.applyMoveText(g.initialState(), "  h8  ").moves, ["h8"], "text is trimmed");
  assert.strictEqual(g.applyMoveText(viaText, "h8"), null, "text placement on occupied cell => null");
  assert.strictEqual(g.applyMoveText(viaText, ""), null, "empty text => null");
  assert.strictEqual(g.applyMoveText(viaText, "zz"), null, "unparseable text => null");

  // moveText must NEVER label a move applyMove would reject: it agrees with
  // applyMove for from !== to, occupied targets, off-board tokens, and terminal
  // positions, returning "" exactly when applyMove returns null. (Regression:
  // moveText used to serialize illegal placements, e.g. "h8" for from a1 / to h8.)
  const st0 = g.initialState();
  assert.strictEqual(g.moveText(st0, "a1", "h8"), "", "from !== to is not labeled");
  assert.strictEqual(g.applyMove(st0, "a1", "h8"), null, "and applyMove rejects it too");
  assert.strictEqual(g.moveText(viaText, "h8", "h8"), "", "occupied target is not labeled");
  assert.strictEqual(g.moveText(st0, "z9", "z9"), "", "off-board token is not labeled");
  const wonForText = play(["d8", "a15", "e8", "b15", "f8", "c15", "g8", "d15", "h8"]);
  assert.strictEqual(g.moveText(wonForText, "o1", "o1"), "", "no label once the game is terminal");
  assert.strictEqual(g.applyMove(wonForText, "o1", "o1"), null, "and applyMove is null once terminal");
  ok("applyMoveText is the inverse of moveText and byte-identical to applyMove");
})();

// ---- 6. positionKey: length, URL-safe, deterministic, visual-only ----------
(function positionKey() {
  const empty = g.initialState();
  const k0 = g.positionKey(empty);
  assert.ok(k0.length <= 115, "empty key <= 115 chars (len " + k0.length + ")");
  assert.ok(/^[A-Za-z0-9._-]+$/.test(k0), "key is URL-safe ASCII");

  const st = play(["h8", "h9", "g7", "g8", "f6"]);
  const k1 = g.positionKey(st);
  assert.ok(k1.length <= 115, "populated key <= 115 chars (len " + k1.length + ")");
  assert.ok(/^[A-Za-z0-9._-]+$/.test(k1), "populated key is URL-safe ASCII");
  assert.strictEqual(k1, g.positionKey(play(["h8", "h9", "g7", "g8", "f6"])), "key is deterministic");
  assert.notStrictEqual(k0, k1, "different positions => different keys");

  // Visual-only: two move orders reaching the SAME stones share one key, even
  // though the move lists (and whose turn it is) differ.
  const A = play(["h8", "h9", "g7", "g8"]); // Black to move
  const B = play(["g7", "h9", "h8", "g8"]); // same 4 stones, different order
  assert.notStrictEqual(JSON.stringify(A.moves), JSON.stringify(B.moves), "genuinely different orders");
  sameShape(g.view(A), g.view(B), "both orders reach the same board");
  assert.strictEqual(g.positionKey(A), g.positionKey(B), "transposition => one shared key");

  // Under the "c2-" version prefix the worker key stays < 128.
  assert.ok(("c2-" + k1).length < 128, "versioned key stays < 128");
  ok("positionKey: <=115, URL-safe, deterministic, and visual-only");
})();

// ---- 7. a draw is representable -------------------------------------------
(function draw() {
  // A completely full board (225 stones) with no five-in-a-row must classify as a
  // draw. terminal()/positionKey read the FINAL board off state.moves and don't
  // care about the order stones arrived, so we build the drawn state DIRECTLY: a
  // five-free coloring, emitted as a move list whose ply parity paints it.
  //
  // Five-free pattern: 2-wide anti-diagonal stripes, color = floor((r+c)/2) mod 2.
  // Along any line (horizontal, vertical, or diagonal) the color repeats in runs
  // of at most 2, so no run ever reaches five. (The engine verifies this for us
  // via terminal(): if the pattern had a five, result would be "w"/"b", not draw.)
  // Build the state for a given 0/1 pattern, mapping the 113-cell majority to
  // White (White moves first) so ply parity paints the coloring exactly.
  function drawnFrom(pattern) {
    const groups = [[], []];
    for (let r = 0; r < 15; r++) {
      for (let c = 0; c < 15; c++) groups[pattern(r, c)].push(g.squareAt(r, c));
    }
    if (groups[0].length !== 113 && groups[1].length !== 113) return null;
    const [whites, blacks] = groups[0].length >= groups[1].length ? groups : [groups[1], groups[0]];
    const moves = [];
    for (let i = 0; i < 113; i++) {
      moves.push(whites[i]);
      if (i < 112) moves.push(blacks[i]);
    }
    return { game: "gomoku", moves };
  }

  // Five-free coloring: color = ((r + 2c) mod 4) < 2. Along every line the color
  // never repeats five times (verified exhaustively), and it splits the 225 cells
  // 113/112 so it maps cleanly onto White-first alternation. terminal() is still
  // the final judge below — if this pattern hid a five it would score "w"/"b".
  const pattern = (r, c) => ((r + 2 * c) % 4 < 2 ? 1 : 0);
  const drawn = drawnFrom(pattern);
  assert.ok(drawn, "five-free pattern splits 113/112 for White-first alternation");

  assert.strictEqual(drawn.moves.length, 225, "board is completely full (225 stones)");
  // Sanity: every cell is filled (no empties) on the reconstructed board.
  const cells = g.view(drawn);
  assert.ok(
    cells.every((row) => row.every((cell) => cell.color === "w" || cell.color === "b")),
    "reconstructed board is completely filled"
  );

  const term = g.terminal(drawn);
  assert.strictEqual(term.over, true, "a full board is terminal");
  assert.strictEqual(term.result, "draw", "full board with no five is a draw");
  assert.strictEqual(g.legalMoves(drawn).length, 0, "no legal moves on a full board");
  assert.strictEqual(g.applyMove(drawn, "a15", "a15"), null, "no moves after a draw");
  // positionKey stays within budget even on a completely full board.
  const k = g.positionKey(drawn);
  assert.ok(k.length <= 115, "full-board key <= 115 chars (len " + k.length + ")");
  assert.ok(/^[A-Za-z0-9._-]+$/.test(k), "full-board key is URL-safe ASCII");
  ok("a draw is representable: full 225-stone board with no five-in-a-row");
})();

// ---- 8. no moves after a win + mustPass invariant -------------------------
(function terminalGuards() {
  const won = play(["d8", "a15", "e8", "b15", "f8", "c15", "g8", "d15", "h8"]);
  assert.strictEqual(g.terminal(won).over, true, "won game is terminal");
  assert.strictEqual(g.applyMove(won, "o1", "o1"), null, "applyMove null after a win");
  assert.strictEqual(g.applyMoveText(won, "o1"), null, "applyMoveText null after a win");
  assert.strictEqual(g.legalMoves(won).length, 0, "no legal moves after a win");
  sameShape(g.legalMovesFrom(won, "o1"), [], "legalMovesFrom empty after a win");
  assert.strictEqual(g.mustPass(won), false, "mustPass stays false even when terminal");
  ok("terminal guards: no moves after a win, mustPass always false");
})();

console.log("\nAll gomoku tests passed (" + passed + " checks).");
