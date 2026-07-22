// Node test for the checkers Game module (src/games/checkers.js). PURE — no DOM,
// no network. Run: `node src/games/checkers.test.js`
//
// Same recreate-the-browser-world approach as share.test.js: the module is an
// IIFE content script mutating a shared `window.Gage`, so we build a vm context
// whose global carries a `window` shim, load the source, then drive
// window.Gage.games.checkers.
//
// Coverage:
//   1. initial setup: piece counts, colors, view glyphs, white to move.
//   2. a simple (non-capturing) man move.
//   3. a FORCED single capture (a non-capture is rejected while a jump exists).
//   4. a MANDATORY multi-jump chain (one move captures two men; a partial chain
//      is rejected).
//   5. KINGING: a man reaching the far row becomes a king (glyph "★").
//   6. applyMoveText <-> applyMove PARITY for step / jump / chain.
//   7. illegal-move rejection: geometry, wrong turn, empty source, malformed,
//      and non-move tokens.
//   8. TERMINAL: the side with no legal move loses; result is the other color;
//      nothing applies once terminal.
//   9. positionKey: 32-char URL-safe visual key, deterministic + sensitive.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// ---- build the browser-like world ----------------------------------------
const sandbox = { console };
sandbox.window = sandbox; // the module targets `window`; make it the global
vm.createContext(sandbox);

const ROOT = path.resolve(__dirname, "..", ".."); // repo root
function load(rel) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), sandbox, { filename: rel });
}

load("src/games/checkers.js");

const Gage = sandbox.window.Gage;
const game = Gage.games.checkers;

let passed = 0;
function ok(name) {
  passed++;
  console.log("  ok  - " + name);
}

// vm-origin arrays/objects carry that realm's prototype, so deepStrictEqual's
// prototype check would fail; compare structurally via JSON instead.
const sameJSON = (a, b, msg) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg);

// Count pieces of a color from a view(): {men, kings, total}.
function countColor(v, color) {
  let men = 0, kings = 0;
  for (const row of v) {
    for (const cell of row) {
      if (cell.color === color) {
        if (cell.glyph === "★") kings++;
        else men++;
      }
    }
  }
  return { men, kings, total: men + kings };
}

// Read a cell at an algebraic square from a view().
function cellAt(v, sq) {
  const col = "abcdefgh".indexOf(sq[0]);
  const row = 8 - (sq.charCodeAt(1) - 48);
  return v[row][col];
}
const isEmptyCell = (cell) => !cell.glyph && !cell.color;

const allSquares = () => {
  const out = [];
  for (const f of "abcdefgh") for (let r = 1; r <= 8; r++) out.push(f + r);
  return out;
};
const rowOf = (sq) => 8 - (sq.charCodeAt(1) - 48);

// ---- 1. initial setup -----------------------------------------------------
(function setup() {
  const st = game.initialState();
  assert.strictEqual(st.game, "checkers", "State carries its game id");
  assert.strictEqual(st.moves.length, 0, "fresh game has no moves");

  const v = game.view(st);
  assert.strictEqual(v.length, 8, "8 rows");
  assert.strictEqual(v[0].length, 8, "8 cols");

  const w = countColor(v, "w");
  const b = countColor(v, "b");
  assert.strictEqual(w.total, 12, "white has 12 men");
  assert.strictEqual(b.total, 12, "black has 12 men");
  assert.strictEqual(w.kings, 0, "no white kings at start");
  assert.strictEqual(b.kings, 0, "no black kings at start");

  // White occupies the dark squares of rows 5,6,7 (ranks 1,2,3); black the dark
  // squares of rows 0,1,2 (ranks 6,7,8).
  assert.strictEqual(cellAt(v, "b2").color, "w", "b2 is a white man");
  assert.strictEqual(cellAt(v, "a1").color, "w", "a1 is a white man");
  assert.strictEqual(cellAt(v, "c3").color, "w", "c3 is a white man");
  assert.strictEqual(cellAt(v, "b8").color, "b", "b8 is a black man");
  assert.strictEqual(cellAt(v, "d6").color, "b", "d6 is a black man");
  assert.strictEqual(cellAt(v, "g7").color, "b", "g7 is a black man");
  // Ranks 4,5 (rows 3,4 — the middle) are empty.
  assert.ok(isEmptyCell(cellAt(v, "c5")), "c5 empty");
  assert.ok(isEmptyCell(cellAt(v, "f4")), "f4 empty");
  // Light squares never hold pieces.
  assert.ok(isEmptyCell(cellAt(v, "a8")), "a8 (light) empty");

  const menGlyphs = v.flat().filter((c) => c.glyph === "●").length;
  assert.strictEqual(menGlyphs, 24, "24 man glyphs total");
  assert.strictEqual(game.turn(st), "w", "white moves first");
  assert.strictEqual(game.terminal(st).over, false, "start is not terminal");
  ok("initial setup: 12+12 men, correct sides, white to move");
})();

// ---- 2. a simple man move -------------------------------------------------
(function simpleMove() {
  const st = game.initialState();
  // White man on c3 (rank 3) can step forward to b4 or d4 (both empty).
  const dests = game.legalMovesFrom(st, "c3").slice().sort();
  sameJSON(dests, ["b4", "d4"], "c3 steps to b4/d4");
  assert.strictEqual(game.moveText(st, "c3", "b4"), "c3-b4", "step notation is from-to");

  const next = game.applyMove(st, "c3", "b4");
  assert.ok(next, "c3-b4 applies");
  sameJSON(next.moves, ["c3-b4"], "move text recorded");
  assert.strictEqual(st.moves.length, 0, "applyMove did not mutate the source state");

  const v = game.view(next);
  assert.ok(isEmptyCell(cellAt(v, "c3")), "c3 now empty");
  assert.strictEqual(cellAt(v, "b4").color, "w", "white man now on b4");
  assert.strictEqual(game.turn(next), "b", "turn flips to black");
  assert.strictEqual(game.isCapture(st, "c3", "b4"), false, "a step is not a capture");
  ok("simple move: white man steps diagonally forward and flips the turn");
})();

// ---- 3. forced single capture ---------------------------------------------
(function forcedCapture() {
  // White a3->b4 advances; black d6->c5 vacates d6 and puts a black man on c5,
  // adjacent to white's b4. White now has the mandatory jump b4 x c5 -> d6 (the
  // just-vacated square is the empty landing). It is the ONLY legal white move.
  let st = game.initialState();
  st = game.applyMoveText(st, "a3-b4");
  assert.ok(st, "a3-b4");
  st = game.applyMoveText(st, "d6-c5");
  assert.ok(st, "d6-c5");

  assert.strictEqual(game.turn(st), "w", "white to move");
  assert.strictEqual(game.moveText(st, "b4", "d6"), "b4xd6", "jump notation uses x + landing");
  assert.strictEqual(game.isCapture(st, "b4", "d6"), true, "b4xd6 is a capture");

  // A NON-capturing white move must be rejected while the jump exists.
  assert.strictEqual(game.applyMove(st, "c3", "d4"), null, "non-capture rejected under forced capture");
  assert.strictEqual(game.applyMoveText(st, "e3-d4"), null, "non-capture text rejected too");
  sameJSON(game.legalMovesFrom(st, "c3"), [], "c3 has no legal move while a jump is forced");
  sameJSON(game.legalMovesFrom(st, "b4"), ["d6"], "only the jumper b4 has a legal dest");

  const after = game.applyMove(st, "b4", "d6");
  assert.ok(after, "the jump applies");
  const v = game.view(after);
  assert.ok(isEmptyCell(cellAt(v, "c5")), "jumped black man on c5 removed");
  assert.strictEqual(cellAt(v, "d6").color, "w", "white lands on d6");
  assert.ok(isEmptyCell(cellAt(v, "b4")), "b4 vacated");
  assert.strictEqual(countColor(v, "b").total, 11, "black lost a piece");
  ok("forced capture: a jump is mandatory and removes the jumped piece");
})();

// Reproduce a position where white man a3 has the mandatory double jump
// a3 x c5 x a7 (jumping a black man on b4, landing c5, then jumping b6, landing
// a7). Reached by a fully legal history; verified in cases 4 and 6.
function doubleJumpState() {
  let st = game.initialState();
  const seq = ["a3-b4", "b6-a5", "b2-a3", "a7-b6", "b4-c5", "d6xb4"];
  for (const mv of seq) {
    st = game.applyMoveText(st, mv);
    assert.ok(st, "double-jump setup move applied: " + mv);
  }
  return st;
}

// ---- 4. mandatory multi-jump chain ----------------------------------------
(function multiJump() {
  const st = doubleJumpState();
  assert.strictEqual(game.turn(st), "w", "white to move for the double jump");

  // White a3 must have the mandatory chain a3 x c5 x a7 (over b4 then b6).
  assert.strictEqual(game.moveText(st, "a3", "a7"), "a3xc5xa7", "double jump lists BOTH landings");
  sameJSON(game.legalMovesFrom(st, "a3"), ["a7"], "a3's only legal dest is the chain end a7");

  const after = game.applyMove(st, "a3", "a7");
  assert.ok(after, "double jump applies");
  const v = game.view(after);
  assert.ok(isEmptyCell(cellAt(v, "b4")), "first victim b4 removed");
  assert.ok(isEmptyCell(cellAt(v, "b6")), "second victim b6 removed");
  assert.ok(isEmptyCell(cellAt(v, "a3")), "a3 vacated");
  assert.strictEqual(cellAt(v, "a7").color, "w", "white lands on a7");
  // a7 is row 1, not the white crown row (row 0), so still a man.
  assert.strictEqual(cellAt(v, "a7").glyph, "●", "lands as a man (a7 is not the crown row)");

  // An INCOMPLETE chain (stopping at c5 when a further jump exists) is illegal:
  // the generator only ever emits COMPLETE chains, so the partial token/dest
  // matches nothing.
  assert.strictEqual(game.applyMove(st, "a3", "c5"), null, "stopping mid-chain at c5 is rejected");
  assert.strictEqual(game.applyMoveText(st, "a3xc5"), null, "incomplete-chain text rejected (continuation mandatory)");
  ok("mandatory multi-jump: one move captures two men; partial chain rejected");
})();

// ---- 5. kinging -----------------------------------------------------------
(function kinging() {
  // Drive a real game with a greedy chooser that marches a white man to the top
  // row, and confirm it crowns to "★". White picks the move with the smallest
  // destination row (toward rank 8); black picks the largest (toward rank 1),
  // out of white's lane. Captures (when forced) are taken as offered.
  const st = buildCrowningState();
  const v = game.view(st);
  const crownSquares = ["b8", "d8", "f8", "h8"]; // dark squares of the top row
  let crowned = null;
  for (const s of crownSquares) {
    const cell = cellAt(v, s);
    if (cell.color === "w" && cell.glyph === "★") crowned = s;
  }
  assert.ok(crowned, "a white man reached the top row and became a king (★)");
  assert.strictEqual(countColor(v, "w").kings, 1, "exactly one white king");

  // A king moves in all four diagonal directions. The greedy racer above ends on
  // BLACK's turn with the king boxed in, so its backward-move check was vacuous
  // (kingDests empty, the `|| length === 0` branch always passed). Assert king
  // backward movement on a DEDICATED, fully-legal position instead: white ends
  // with a king on d8 whose ONLY legal move is the down-board (backward) step to
  // c7 — a move no white MAN could ever make. This fails if kings lose their
  // backward directions.
  const KING_BACK = [
    "a3-b4","d6-c5","b4xd6","e7xc5","c3-d4","b6-a5","d4xb6","a7xc5","d2-c3","c5-d4",
    "e3xc5","h6-g5","c3-d4","f8-e7","c5-b6","g7-h6","c1-d2","h8-g7","b2-c3","c7-d6",
    "b6-a7","d6-c5","d4xb6","d8-c7","b6xd8","g5-h4",
  ];
  let ks = game.initialState();
  for (const m of KING_BACK) {
    ks = game.applyMoveText(ks, m);
    assert.ok(ks, "king-backward setup move applied: " + m);
  }
  assert.strictEqual(game.turn(ks), "w", "white to move with the king on d8");
  const d8 = cellAt(game.view(ks), "d8");
  assert.strictEqual(d8.color, "w", "d8 holds a white piece");
  assert.strictEqual(d8.glyph, "★", "the d8 piece is a king");
  const backDests = game.legalMovesFrom(ks, "d8");
  assert.ok(backDests.length > 0, "the king actually has a legal move (non-vacuous)");
  assert.ok(
    backDests.some((d) => rowOf(d) > rowOf("d8")),
    "the king steps BACKWARD (down-board) — a direction no white man has"
  );
  assert.ok(game.applyMoveText(ks, "d8-c7"), "the backward king step is legal");
  ok("kinging: a man reaching the far row crowns to a king glyph ★ that moves backward");
})();

// Greedy driver: race a white man to the top row and stop once a white king
// exists. Every move is validated through applyMoveText, so the resulting State
// is a legal game.
function buildCrowningState() {
  let st = game.initialState();
  for (let ply = 0; ply < 200; ply++) {
    if (game.terminal(st).over) break;
    if (countColor(game.view(st), "w").kings >= 1) break;
    const color = game.turn(st);
    const move = chooseRaceMove(st, color);
    assert.ok(move, "a legal move exists at ply " + ply);
    const next = game.applyMoveText(st, move);
    assert.ok(next, "chosen move applies: " + move);
    st = next;
  }
  return st;
}

// White wants the destination closest to rank 8 (min row); black wants the
// destination closest to rank 1 (max row), keeping clear of white's lane.
function chooseRaceMove(st, color) {
  let best = null, bestScore = null;
  for (const from of allSquares()) {
    for (const to of game.legalMovesFrom(st, from)) {
      const tr = rowOf(to);
      const score = color === "w" ? tr : -tr;
      if (bestScore === null || score < bestScore) {
        bestScore = score;
        best = game.moveText(st, from, to);
      }
    }
  }
  return best;
}

// ---- 6. applyMoveText <-> applyMove parity --------------------------------
(function parity() {
  // Step parity.
  const st0 = game.initialState();
  sameJSON(
    game.applyMove(st0, "b6", "c5"),
    game.applyMoveText(st0, "b6-c5"),
    "step: applyMove == applyMoveText"
  );

  // Single-jump parity.
  let sj = game.initialState();
  sj = game.applyMoveText(sj, "a3-b4");
  sj = game.applyMoveText(sj, "d6-c5");
  sameJSON(
    game.applyMove(sj, "b4", "d6"),
    game.applyMoveText(sj, "b4xd6"),
    "jump: applyMove == applyMoveText"
  );
  sameJSON(game.applyMove(sj, "b4", "d6").moves.slice(-1), ["b4xd6"], "canonical jump token stored");

  // Chain parity.
  const dbl = doubleJumpState();
  sameJSON(
    game.applyMove(dbl, "a3", "a7"),
    game.applyMoveText(dbl, "a3xc5xa7"),
    "chain: applyMove == applyMoveText"
  );
  ok("parity: applyMove and applyMoveText produce identical State for step/jump/chain");
})();

// ---- 7. illegal-move rejection --------------------------------------------
(function illegal() {
  const st = game.initialState();
  assert.strictEqual(game.applyMove(st, "b6", "b5"), null, "orthogonal (non-diagonal) move rejected");
  assert.strictEqual(game.applyMove(st, "b6", "d4"), null, "two-square non-jump rejected");
  assert.strictEqual(game.applyMove(st, "b8", "c7"), null, "moving the opponent's piece rejected (not black's turn)");
  assert.strictEqual(game.applyMove(st, "c5", "d4"), null, "moving from an empty square rejected");
  assert.strictEqual(game.applyMove(st, "a1", "b2"), null, "step onto an occupied friendly square rejected");
  assert.strictEqual(game.applyMoveText(st, "b6-b5"), null, "unparseable/illegal text rejected");
  assert.strictEqual(game.applyMoveText(st, "z9-a1"), null, "malformed square rejected");
  assert.strictEqual(game.applyMoveText(st, ""), null, "empty text rejected");
  assert.strictEqual(game.applyMoveText(st, "pass"), null, "checkers never passes");
  ok("illegal-move rejection: geometry, turn, empty-source, malformed, and non-move tokens");
})();

// ---- 8. terminal: no-move loss --------------------------------------------
(function terminalLoss() {
  // A complete, fully-legal game (every token applies in turn) whose final
  // position leaves BLACK with no piece able to move -> Black loses, result "w".
  // Replaying it through applyMoveText exercises the whole engine end to end.
  const GAME = [
    "e3-f4","f6-e5","c3-d4","e5xc3","d2xb4","d6-c5","b4xd6","e7xc5","g3-h4","f8-e7",
    "h2-g3","c5-d4","g1-h2","g7-f6","b2-c3","d4xb2","a1xc3","h6-g5","f4xh6","h8-g7",
    "h6xf8","c7-d6","g3-f4","b6-c5","f4-e5","d6xf4","f8xd6xb4","d8-c7","c1-b2","c7-b6",
    "f2-g3","f6-e5","c3-d4","e5xc3xa1","g3xe5","b6-a5","e1-f2","a5xc3","e5-f6","c3-d2",
    "f6-e7","a1-b2","h4-g5","b8-c7","f2-g3","b2-c1","g3-f4","a7-b6","f4-e5","b6-a5",
    "g5-f6","c7-b6","h2-g3","a5-b4","a3xc5xa7","d2-e1","f6-g7","e1-f2","a7-b8","f2xh4",
    "g7-f8","c1-d2","e5-d6","d2-e3","d6-c7","h4-g5","c7-d8","g5-f4","f8-g7","f4-g3",
    "g7-h6","g3-h4","b8-c7","h4-g5","h6xf4xd2",
  ];
  let st = game.initialState();
  for (let i = 0; i < GAME.length; i++) {
    assert.strictEqual(game.terminal(st).over, false, "game not over before move " + i + " (" + GAME[i] + ")");
    const next = game.applyMoveText(st, GAME[i]);
    assert.ok(next, "game move " + i + " applied: " + GAME[i]);
    st = next;
  }

  const term = game.terminal(st);
  assert.strictEqual(term.over, true, "the game reaches a terminal position");
  assert.strictEqual(game.turn(st), "b", "Black is the side to move at the end");
  assert.strictEqual(term.result, "w", "result = White (Black, to move, has no legal move and loses)");
  // The rule, stated generally: the winner is the color NOT to move.
  assert.strictEqual(term.result, game.turn(st) === "w" ? "b" : "w", "result = the color NOT to move");

  // Once terminal, NO move applies and no square has a legal destination.
  assert.strictEqual(game.applyMove(st, "a1", "b2"), null, "no applyMove after game over");
  assert.strictEqual(game.applyMoveText(st, GAME[0]), null, "no applyMoveText after game over");
  let anyDest = false;
  for (const sq of allSquares()) if (game.legalMovesFrom(st, sq).length) anyDest = true;
  assert.strictEqual(anyDest, false, "no legal destinations for anyone in a terminal state");
  ok("terminal: the side with no legal move loses; result is the other color; nothing applies after");
})();

// ---- 9. positionKey -------------------------------------------------------
(function positionKeyCheck() {
  const st = game.initialState();
  const k = game.positionKey(st);
  assert.strictEqual(k.length, 32, "32 dark squares encoded");
  assert.ok(/^[A-Za-z0-9._-]+$/.test(k), "positionKey is URL-safe ASCII");
  assert.ok(k.length <= 115, "positionKey fits the worker key budget");
  assert.strictEqual((k.match(/b/g) || []).length, 12, "12 black men in key");
  assert.strictEqual((k.match(/w/g) || []).length, 12, "12 white men in key");
  assert.strictEqual((k.match(/-/g) || []).length, 8, "8 empty middle squares in key");
  assert.strictEqual(k, game.positionKey(game.initialState()), "positionKey deterministic");
  const moved = game.applyMove(st, "c3", "b4");
  assert.ok(moved, "c3-b4 applies");
  assert.notStrictEqual(k, game.positionKey(moved), "different position => different key");
  ok("positionKey: 32-char URL-safe visual key, deterministic and position-sensitive");
})();

// ---- 10. distinct chains sharing from/to are BOTH reachable ---------------
// Regression for the click/text-equivalence bug: two legal jump chains can
// share the same origin AND the same final landing while capturing different
// pieces (here a white king on g1 that can go g1xe3xc5xe7 or g1xe3xg5xe7).
// legalMovesFrom collapses both to the single endpoint e7, and a bare from/to
// applyMove can only ever pick the first — so the second chain was UNREACHABLE
// by click. Callers can now disambiguate with opts.path (the ordered landing
// list), restoring parity with applyMoveText (which distinguishes by token).
(function ambiguousChains() {
  // A fully-legal 34-ply history that reaches the fork (white to move on g1).
  const HISTORY = [
    "e3-d4","f6-e5","d4xf6","g7xe5","c3-d4","e5xc3","d2xb4","h8-g7","c1-d2","b6-c5",
    "d2-c3","h6-g5","c3-d4","c5xe3","f2xd4","c7-b6","d4-c5","b6xd4","g3-f4","g5xe3",
    "e1-f2","d8-c7","f2-g3","g7-h6","b4-a5","c7-b6","a5xc7","h6-g5","g3-h4","e7-f6",
    "c7-d8","g5-f4","d8-c7","e3-f2",
  ];
  let st = game.initialState();
  for (const m of HISTORY) {
    st = game.applyMoveText(st, m);
    assert.ok(st, "fork-setup move applied: " + m);
  }
  assert.strictEqual(game.turn(st), "w", "white to move at the fork");

  // Both chains exist as distinct legal moves, but they collapse to one endpoint.
  sameJSON(game.legalMovesFrom(st, "g1"), ["e7"], "g1's chains share the endpoint e7");
  const chainA = "g1xe3xc5xe7";
  const chainB = "g1xe3xg5xe7";
  assert.notStrictEqual(chainA, chainB, "the two chains are genuinely different moves");

  // Text path: both chains reachable (they carry distinct tokens).
  assert.ok(game.applyMoveText(st, chainA), "chain A reachable via text");
  assert.ok(game.applyMoveText(st, chainB), "chain B reachable via text");

  // Bare from/to (what the two-click UI supplies) can only reach the first.
  const bare = game.applyMove(st, "g1", "e7");
  assert.ok(bare, "bare from/to applies SOME chain");
  assert.strictEqual(bare.moves[bare.moves.length - 1], chainA, "bare from/to picks the first chain");

  // With opts.path the caller selects EITHER chain — including the one the bare
  // endpoint could never reach — so click and text are equivalent again.
  const viaA = game.applyMove(st, "g1", "e7", { path: ["e3", "c5", "e7"] });
  const viaB = game.applyMove(st, "g1", "e7", { path: ["e3", "g5", "e7"] });
  assert.ok(viaA && viaB, "both chains apply when disambiguated by path");
  assert.strictEqual(viaA.moves[viaA.moves.length - 1], chainA, "path (e3,c5,e7) selects chain A");
  assert.strictEqual(viaB.moves[viaB.moves.length - 1], chainB, "path (e3,g5,e7) selects the OTHER chain B");
  sameJSON(viaB, game.applyMoveText(st, chainB), "path-disambiguated applyMove == applyMoveText for chain B");

  // moveText / isCapture honor the same disambiguation.
  assert.strictEqual(game.moveText(st, "g1", "e7", { path: ["e3", "g5", "e7"] }), chainB, "moveText resolves chain B by path");
  assert.strictEqual(game.isCapture(st, "g1", "e7", { path: ["e3", "g5", "e7"] }), true, "isCapture resolves chain B by path");

  // A path that no legal chain matches is rejected (not silently coerced).
  assert.strictEqual(game.applyMove(st, "g1", "e7", { path: ["e3", "c5", "a3"] }), null, "non-matching path rejected");
  assert.strictEqual(game.applyMove(st, "g1", "e7", { path: ["e3", "c5"] }), null, "wrong-length path rejected");
  assert.strictEqual(game.applyMove(st, "g1", "e7", { path: ["e3", "zz", "e7"] }), null, "malformed square in path rejected");
  ok("ambiguous chains: distinct jumps sharing from/to are both reachable via opts.path");
})();

// ---- 11. path disambiguation is a no-op for unambiguous endpoints ---------
// Passing the correct path for an ordinary chain resolves the same move; a
// wrong path for it is rejected rather than falling back to the endpoint match.
(function pathNoOp() {
  const st = doubleJumpState(); // white a3 has the single chain a3xc5xa7
  assert.strictEqual(game.moveText(st, "a3", "a7", { path: ["c5", "a7"] }), "a3xc5xa7", "correct path resolves the chain");
  sameJSON(
    game.applyMove(st, "a3", "a7", { path: ["c5", "a7"] }),
    game.applyMove(st, "a3", "a7"),
    "correct path == bare endpoint when unambiguous"
  );
  assert.strictEqual(game.applyMove(st, "a3", "a7", { path: ["e3", "a7"] }), null, "a path that no chain matches is rejected");
  ok("path disambiguation: no-op for unambiguous endpoints, still validated");
})();

// ---- 12. corrupt history is rejected, not silently truncated --------------
// Regression: replay used to stop at the first unresolvable token and treat the
// position as a FRESH game — so a state with a bogus move would (a) render/act
// as the start board and (b) accept new moves, leaving a nonsensical history
// like ["bogus","c3-b4"]. A corrupt/tampered state is now refused everywhere.
(function corruptHistory() {
  const corrupt = { game: "checkers", moves: ["bogus"] };
  // No move applies against a corrupt base (previously returned a spliced state).
  assert.strictEqual(game.applyMove(corrupt, "c3", "b4"), null, "applyMove refuses a corrupt history");
  assert.strictEqual(game.applyMoveText(corrupt, "c3-b4"), null, "applyMoveText refuses a corrupt history");
  assert.strictEqual(game.moveText(corrupt, "c3", "b4"), "", "moveText yields nothing for a corrupt history");
  sameJSON(game.legalMovesFrom(corrupt, "c3"), [], "no legal destinations on a corrupt history");

  // terminal reports corruption instead of inventing a winner from the partial board.
  const term = game.terminal(corrupt);
  assert.strictEqual(term.over, false, "a corrupt history is not 'over'");
  assert.strictEqual(term.corrupt, true, "terminal flags the corruption");
  assert.strictEqual(term.result, undefined, "no winner is invented for a corrupt history");

  // A bogus token buried mid-history is caught too (not just a leading one).
  const midCorrupt = { game: "checkers", moves: ["c3-b4", "nope", "d6-c5"] };
  assert.strictEqual(game.applyMove(midCorrupt, "b4", "c5"), null, "corruption anywhere in the history is refused");
  ok("corrupt history: rejected everywhere, never silently truncated into a fresh game");
})();

console.log("\nAll checkers tests passed (" + passed + " checks).");
