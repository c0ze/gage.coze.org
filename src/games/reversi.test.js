// Node test for the reversi game module (src/games/reversi.js) — PURE, so we
// recreate the browser world with a vm context (the same pattern as
// share.test.js / orchestration.test.js): a sandbox whose global carries a
// `window` shim, load the IIFE source, then drive window.Gage.games.reversi.
//
// Run: `node src/games/reversi.test.js`
//
// Coverage:
//   1. initial 4-disc setup (board, counts, White to move).
//   2. the 4 legal opening placements for White (c5/d6/e3/f4).
//   3. a placement that flips in ONE direction and one that flips in MULTIPLE.
//   4. an illegal (zero-flip) placement is rejected.
//   5. a forced PASS scenario: mustPass + the "pass" token flips the turn.
//   6. applyMoveText <-> applyMove parity (byte-identical States).
//   7. disc-count terminal + a draw.
//   8. legalMoves() / mustPass() correctness.
//   9. corrupt histories (zero-flip / occupied / premature pass / malformed /
//      token-after-end) are refused per the checkers replay contract.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// ---- build the browser-like world ----------------------------------------
const sandbox = { console };
sandbox.window = sandbox; // the module IIFE targets `window`; make it the global
vm.createContext(sandbox);

const ROOT = path.resolve(__dirname, "..", ".."); // repo root
function load(rel) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), sandbox, { filename: rel });
}
load("src/games/reversi.js");

const R = sandbox.window.Gage.games.reversi;

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
function sortedTokens(arr) {
  return arr.slice().sort();
}

// Apply a line of placement/pass tokens through applyMoveText (the transport
// path), asserting each is accepted.
function stateFromTokens(tokens) {
  let st = R.initialState();
  for (const tok of tokens) {
    st = R.applyMoveText(st, tok);
    assert.ok(st, "applyMoveText accepted " + tok);
  }
  return st;
}

// The color at an algebraic square in a state's view (or "" if empty).
function discAt(state, sq) {
  const col = "abcdefgh".indexOf(sq[0]);
  const row = 8 - Number(sq[1]);
  const cell = R.view(state)[row][col];
  return cell.color || "";
}

// ---- 1. initial 4-disc setup ----------------------------------------------
(function initialSetup() {
  const s = R.initialState();
  sameShape(s, { game: "reversi", moves: [] }, "fresh state is empty move list");
  assert.strictEqual(R.turn(s), "w", "White moves first");

  // The four centre squares: d4/e5 white, d5/e4 black; everything else empty.
  assert.strictEqual(discAt(s, "d4"), "w", "d4 = white");
  assert.strictEqual(discAt(s, "e5"), "w", "e5 = white");
  assert.strictEqual(discAt(s, "d5"), "b", "d5 = black");
  assert.strictEqual(discAt(s, "e4"), "b", "e4 = black");

  // Exactly 4 discs on the board, 2 each; the rest empty; disc glyph is "●".
  let discs = 0;
  const grid = R.view(s);
  for (const row of grid) {
    for (const cell of row) {
      if (cell.color) {
        discs++;
        assert.strictEqual(cell.glyph, "●", "disc glyph is ●");
      }
    }
  }
  assert.strictEqual(discs, 4, "exactly 4 discs at setup");
  assert.strictEqual(R.terminal(s).over, false, "opening position is not terminal");
  ok("initial 4-disc setup: centre filled, White to move, 4 discs");
})();

// ---- 2. the 4 legal opening placements for White --------------------------
(function openingMoves() {
  const s = R.initialState();
  const moves = R.legalMoves(s);
  // Setup d4/e5=white, d5/e4=black => White's flanks land on c5/d6/e3/f4.
  sameShape(
    sortedTokens(moves),
    ["c5", "d6", "e3", "f4"],
    "White's four legal opening placements"
  );
  // legalMovesFrom mirrors legalMoves: [sq] for a legal square, [] otherwise.
  for (const sq of moves) {
    sameShape(R.legalMovesFrom(s, sq), [sq], "legalMovesFrom returns [" + sq + "]");
  }
  sameShape(R.legalMovesFrom(s, "d4"), [], "legalMovesFrom on an occupied square is []");
  sameShape(R.legalMovesFrom(s, "a1"), [], "legalMovesFrom on a non-flipping square is []");
  ok("opening: exactly c5/d6/e3/f4 are legal for White, mirrored by legalMovesFrom");
})();

// ---- 3. flip in ONE direction, then in MULTIPLE ---------------------------
(function flipsDirections() {
  // ONE direction: White opens d6. The only flank is the vertical line
  // d6 -> d5(black) -> d4(white): it flips exactly the single black disc on d5.
  const s0 = R.initialState();
  const beforeBlacks = countColor(R.view(s0), "b");
  const s1 = R.applyMove(s0, "d6", "d6");
  assert.ok(s1, "d6 is a legal opening placement");
  assert.strictEqual(discAt(s1, "d6"), "w", "d6 now holds a white disc");
  assert.strictEqual(discAt(s1, "d5"), "w", "the flanked black disc on d5 flipped to white");
  const afterBlacks = countColor(R.view(s1), "b");
  assert.strictEqual(afterBlacks, beforeBlacks - 1, "d6 flips exactly one black disc (one direction)");
  assert.strictEqual(multiDirectionCount(s0, "d6", "w"), 1, "d6 flanks in exactly one direction");
  assert.strictEqual(R.turn(s1), "b", "turn passes to Black after White's placement");

  // MULTIPLE directions: search a seeded legal game for a placement that flanks
  // opponent runs in >= 2 of the 8 lines, then assert the disc delta.
  const multi = findMultiDirectionFlip();
  assert.ok(multi, "found a placement that flips in >= 2 directions");
  const before = countColor(R.view(multi.state), other(multi.color));
  const placed = R.applyMove(multi.state, multi.sq, multi.sq);
  assert.ok(placed, "the multi-direction placement is legal");
  const after = countColor(R.view(placed), other(multi.color));
  assert.ok(before - after >= 2, "placement flips >= 2 opponent discs (multi-direction)");
  ok("flips: single-direction (d6) and multi-direction placements flip correctly");
})();

// ---- 4. illegal (zero-flip) placement rejected ----------------------------
(function illegalPlacement() {
  const s = R.initialState();
  // A disc placed with no flank is illegal (must flip >= 1). a1 flanks nothing.
  assert.strictEqual(R.applyMove(s, "a1", "a1"), null, "a1 flips nothing => rejected");
  // An occupied square is illegal too.
  assert.strictEqual(R.applyMove(s, "d4", "d4"), null, "occupied d4 => rejected");
  // A 'placement' with from !== to is not a placement move.
  assert.strictEqual(R.applyMove(s, "d3", "c4"), null, "from!==to => rejected");
  // Off-board / malformed tokens.
  assert.strictEqual(R.applyMove(s, "z9", "z9"), null, "off-board token => rejected");
  // applyMoveText mirrors: a non-flipping token is rejected, and "pass" is
  // rejected while a legal placement still exists.
  assert.strictEqual(R.applyMoveText(s, "a1"), null, "applyMoveText a1 => null");
  assert.strictEqual(R.applyMoveText(s, "pass"), null, "cannot pass when a move exists");
  ok("illegal: zero-flip / occupied / off-board / premature pass all rejected");
})();

// ---- 5. forced PASS scenario ----------------------------------------------
(function forcedPass() {
  // Construct a position where the side to move has NO legal placement but the
  // opponent does. We build one by search: play a legal game until some side is
  // forced to pass (mustPass true) while the game is not over.
  const found = findForcedPass();
  assert.ok(found, "reached a position with a forced pass");
  const s = found.state;
  assert.strictEqual(R.mustPass(s), true, "side to move must pass");
  assert.strictEqual(R.legalMoves(s).length, 0, "no legal placements for the side to move");
  assert.strictEqual(R.terminal(s).over, false, "the game is not over (opponent can move)");

  const beforeTurn = R.turn(s);
  const beforeKey = R.positionKey(s);
  const passed = R.applyMoveText(s, "pass");
  assert.ok(passed, "'pass' is accepted when forced");
  assert.strictEqual(R.turn(passed), other(beforeTurn), "pass flips the turn");
  assert.strictEqual(R.positionKey(passed), beforeKey, "pass leaves the board unchanged");
  // moveText/legalMoves after passing: the opponent (who has a move) is up.
  assert.ok(R.legalMoves(passed).length > 0, "opponent has moves after the pass");
  ok("forced pass: mustPass true, 'pass' flips turn and preserves the board");
})();

// ---- 6. applyMoveText <-> applyMove parity --------------------------------
(function parity() {
  // Replay a legal line two ways and assert byte-identical States at each step.
  const line = randomLegalLine(20);
  let viaMove = R.initialState();
  let viaText = R.initialState();
  for (const tok of line) {
    if (tok === "pass") {
      viaMove = R.applyMoveText(viaMove, "pass"); // pass has no from/to form
    } else {
      viaMove = R.applyMove(viaMove, tok, tok);
    }
    viaText = R.applyMoveText(viaText, tok);
    assert.ok(viaMove && viaText, "both paths accept " + tok);
    sameShape(viaMove, viaText, "States match after " + tok);
  }
  // moveText round-trips a placement token against the pre-move state.
  const s0 = R.initialState();
  const opening = R.legalMoves(s0)[0];
  assert.strictEqual(R.moveText(s0, opening, opening), opening, "moveText = placed square token");
  sameShape(
    R.applyMoveText(s0, R.moveText(s0, opening, opening)),
    R.applyMove(s0, opening, opening),
    "moveText -> applyMoveText == applyMove"
  );
  ok("parity: applyMove and applyMoveText produce byte-identical States");
})();

// ---- 7. disc-count terminal + draw ----------------------------------------
(function terminalAndDraw() {
  // (a) A decisive finish: play a full random legal game to the end; terminal
  // reports the majority color, and no move is accepted afterwards.
  const end = playToEnd();
  const t = R.terminal(end.state);
  assert.strictEqual(t.over, true, "a completed game is terminal");
  const c = countBoth(R.view(end.state));
  if (c.w > c.b) assert.strictEqual(t.result, "w", "White majority => White wins");
  else if (c.b > c.w) assert.strictEqual(t.result, "b", "Black majority => Black wins");
  else assert.strictEqual(t.result, "draw", "equal => draw");
  assert.strictEqual(R.applyMove(end.state, "a1", "a1"), null, "no placement after game over");
  assert.strictEqual(R.applyMoveText(end.state, "pass"), null, "no pass after game over");
  // terminal()'s reported result matches an independent disc count of the board.
  const expected = c.w > c.b ? "w" : c.b > c.w ? "b" : "draw";
  assert.strictEqual(t.result, expected, "terminal result matches the disc majority");

  // (b) A real DRAW: search seeded legal games to the end until one finishes
  // with equal disc counts, then assert terminal() reports "draw".
  const drawEnd = findDrawnGame();
  assert.ok(drawEnd, "found a legal game that ends in a tie");
  const dc = countBoth(R.view(drawEnd.state));
  assert.strictEqual(dc.w, dc.b, "the drawn game really has equal disc counts");
  assert.strictEqual(R.terminal(drawEnd.state).over, true, "the drawn game is terminal");
  assert.strictEqual(R.terminal(drawEnd.state).result, "draw", "equal counts => draw");
  ok("terminal: majority wins, equal counts draw, no moves after game over");
})();

// ---- 8. legalMoves() / mustPass() correctness -----------------------------
(function legalityHelpers() {
  const s = R.initialState();
  // Opening: 4 legal moves, no pass, not terminal.
  assert.strictEqual(R.legalMoves(s).length, 4, "4 opening placements");
  assert.strictEqual(R.mustPass(s), false, "no pass at the opening");
  // Every legalMoves() square is accepted by applyMove and flips >= 1 disc.
  for (const sq of R.legalMoves(s)) {
    const ns = R.applyMove(s, sq, sq);
    assert.ok(ns, sq + " is playable");
    const before = countBoth(R.view(s));
    const after = countBoth(R.view(ns));
    // One disc placed + >=1 flipped => opponent lost >=1, we gained >=2.
    assert.ok(after.w + after.b === before.w + before.b + 1, "one new disc added");
  }
  // On a terminal board, legalMoves is [] and mustPass is false (game over).
  const end = playToEnd();
  assert.strictEqual(R.legalMoves(end.state).length, 0, "terminal => no legal moves");
  assert.strictEqual(R.mustPass(end.state), false, "terminal is not a pass, it's game over");
  ok("helpers: legalMoves/mustPass agree with applyMove and terminality");
})();

// ---- 9. corrupt histories are refused (checkers replay contract) ----------
// States arrive base64-decoded from URLs (untrusted). A token list that does
// not replay as a legal game must be refused: terminal reports
// { over:false, corrupt:true } and every consumer path declines to offer or
// accept moves against the corrupt base — exactly like checkers.
(function corruptHistories() {
  function assertCorrupt(state, label) {
    const t = R.terminal(state);
    assert.strictEqual(t.over, false, label + ": terminal.over is false");
    assert.strictEqual(t.corrupt, true, label + ": terminal.corrupt is true");
    assert.strictEqual(t.result, undefined, label + ": no result is invented");
    sameShape(R.legalMoves(state), [], label + ": legalMoves is empty");
    sameShape(R.legalMovesFrom(state, "d6"), [], label + ": legalMovesFrom is empty");
    assert.strictEqual(R.mustPass(state), false, label + ": mustPass is false (not a stuck side)");
    assert.strictEqual(R.applyMove(state, "d6", "d6"), null, label + ": applyMove is null");
    assert.strictEqual(R.applyMoveText(state, "d6"), null, label + ": applyMoveText is null");
    assert.strictEqual(R.applyMoveText(state, "pass"), null, label + ": 'pass' is refused");
    assert.strictEqual(R.isCapture(state, "d6", "d6"), false, label + ": isCapture is false");
    assert.strictEqual(R.moveText(state, "d6", "d6"), "", label + ": moveText labels nothing");
  }

  // A zero-flip placement (a1 flanks nothing at the start).
  assertCorrupt({ game: "reversi", moves: ["a1"] }, "zero-flip");
  // A placement onto an occupied centre square.
  assertCorrupt({ game: "reversi", moves: ["d4"] }, "occupied");
  // A premature "pass" while legal placements exist.
  assertCorrupt({ game: "reversi", moves: ["pass"] }, "premature pass");
  // A malformed token.
  assertCorrupt({ game: "reversi", moves: ["zz"] }, "malformed");

  // A corrupt token AFTER a valid prefix: the board freezes at the last good
  // position — the view renders the prefix, never a nonsense board.
  const good = { game: "reversi", moves: ["d6"] };
  const bad = { game: "reversi", moves: ["d6", "a1"] };
  assertCorrupt(bad, "bad suffix");
  sameShape(R.view(bad), R.view(good), "view renders the last good prefix");
  assert.strictEqual(R.positionKey(bad), R.positionKey(good), "positionKey frozen at last good position");

  // Any token appended after a genuinely finished game is corrupt too ("pass"
  // included: at a double-dead position the opponent has no move either).
  const end = playToEnd().state;
  assertCorrupt({ game: "reversi", moves: end.moves.concat(["pass"]) }, "pass after game over");

  // Valid states never report corrupt.
  assert.strictEqual(R.terminal(R.initialState()).corrupt, undefined, "fresh state is not corrupt");
  assert.strictEqual(R.terminal(good).corrupt, undefined, "a valid history is not corrupt");
  assert.strictEqual(R.terminal(end).over, true, "a finished valid game stays terminal, not corrupt");
  ok("corrupt histories: terminal {over:false,corrupt:true}, no moves offered or accepted");
})();

// ---- shared helpers for the search-based fixtures --------------------------
function other(color) {
  return color === "w" ? "b" : "w";
}
function countColor(grid, color) {
  let n = 0;
  for (const row of grid) for (const cell of row) if (cell.color === color) n++;
  return n;
}
function countBoth(grid) {
  return { w: countColor(grid, "w"), b: countColor(grid, "b") };
}

// A tiny deterministic PRNG (mulberry32) so search-based fixtures are stable.
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Play a full legal game to termination with a seeded random policy (passing
// when forced). Returns { state }.
function playToEnd(seed) {
  const rand = rng(seed || 12345);
  let st = R.initialState();
  let guard = 0;
  while (!R.terminal(st).over && guard++ < 200) {
    const moves = R.legalMoves(st);
    if (moves.length === 0) {
      st = R.applyMoveText(st, "pass");
    } else {
      const sq = moves[Math.floor(rand() * moves.length)] || moves[0];
      st = R.applyMove(st, sq, sq);
    }
  }
  return { state: st };
}

// Search seeded random games for one that ends in a tie (equal disc counts).
function findDrawnGame() {
  for (let seed = 1; seed < 5000; seed++) {
    const end = playToEnd(seed);
    const c = countBoth(R.view(end.state));
    if (c.w === c.b) return end;
  }
  return null;
}

// Search random games for a non-terminal position where the side to move has
// no legal placement (a forced pass). Returns { state } or null.
function findForcedPass() {
  for (let seed = 1; seed < 400; seed++) {
    const rand = rng(seed);
    let st = R.initialState();
    let guard = 0;
    while (!R.terminal(st).over && guard++ < 200) {
      if (R.mustPass(st)) return { state: st };
      const moves = R.legalMoves(st);
      const sq = moves[Math.floor(rand() * moves.length)] || moves[0];
      st = R.applyMove(st, sq, sq);
    }
  }
  return null;
}

// Search for a legal placement that flips discs in >= 2 directions.
function findMultiDirectionFlip() {
  for (let seed = 1; seed < 400; seed++) {
    const rand = rng(seed);
    let st = R.initialState();
    let guard = 0;
    while (!R.terminal(st).over && guard++ < 200) {
      const color = R.turn(st);
      const moves = R.legalMoves(st);
      if (moves.length === 0) {
        st = R.applyMoveText(st, "pass");
        continue;
      }
      for (const sq of moves) {
        const before = countColor(R.view(st), other(color));
        const ns = R.applyMove(st, sq, sq);
        const after = countColor(R.view(ns), other(color));
        // Flipping >= 2 in one placement most reliably indicates a multi-line
        // flank once the board has grown; require the placement to sit where
        // two directions genuinely contribute.
        if (before - after >= 2 && multiDirection(st, sq, color)) {
          return { state: st, sq, color };
        }
      }
      const pick = moves[Math.floor(rand() * moves.length)] || moves[0];
      st = R.applyMove(st, pick, pick);
    }
  }
  return null;
}

// Number of the 8 lines in which placing `color` at `sq` flanks an opponent
// run terminated by our own disc. Recomputed independently of the module (off
// view()) so the test verifies the module's flip behaviour rather than trusting
// it. multiDirection() is the >= 2 predicate used by the search.
function multiDirectionCount(state, sq, color) {
  const grid = R.view(state);
  const board = grid.map((row) => row.map((cell) => cell.color || ""));
  const col = "abcdefgh".indexOf(sq[0]);
  const row = 8 - Number(sq[1]);
  const opp = other(color);
  const DIRS = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1], [0, 1],
    [1, -1], [1, 0], [1, 1],
  ];
  let lines = 0;
  for (const [dr, dc] of DIRS) {
    let r = row + dr;
    let c = col + dc;
    let run = 0;
    while (r >= 0 && r < 8 && c >= 0 && c < 8 && board[r][c] === opp) {
      run++;
      r += dr;
      c += dc;
    }
    if (run > 0 && r >= 0 && r < 8 && c >= 0 && c < 8 && board[r][c] === color) lines++;
  }
  return lines;
}
function multiDirection(state, sq, color) {
  return multiDirectionCount(state, sq, color) >= 2;
}

// A seeded legal line of up to `n` tokens (placements + forced passes).
function randomLegalLine(n) {
  const rand = rng(777);
  let st = R.initialState();
  const out = [];
  let guard = 0;
  while (out.length < n && !R.terminal(st).over && guard++ < 200) {
    if (R.mustPass(st)) {
      out.push("pass");
      st = R.applyMoveText(st, "pass");
      continue;
    }
    const moves = R.legalMoves(st);
    const sq = moves[Math.floor(rand() * moves.length)] || moves[0];
    out.push(sq);
    st = R.applyMove(st, sq, sq);
  }
  return out;
}

console.log("\nAll reversi tests passed (" + passed + " checks).");
