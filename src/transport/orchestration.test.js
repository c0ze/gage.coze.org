// Node test for the orchestration DECISION layer (Gage.orchestration.decide).
// Run: `node src/transport/orchestration.test.js`
//
// decide() is PURE (window.Gage.{protocol,reconstruct,games} only, no DOM), so
// we recreate the browser world with a vm context — the same pattern as
// transport.test.js — load the pure sources in manifest order, then feed decide()
// raw thread texts + (me, rootAuthor) handles and assert the { gameId, myColor,
// turn, over, interactive, error } it derives.
//
// Coverage: White-to-move, Black-to-move, spectator, and desync — plus practice
// (non-Gage) and not-your-turn.
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

const ROOT = path.resolve(__dirname, "..", ".."); // repo root
function load(rel) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), sandbox, { filename: rel });
}

// Manifest order (only the PURE modules decide() needs — no DOM layer):
load("src/vendor/chess.js");
load("src/games/chess.js");
load("src/seed.js");
load("src/transport/protocol.js");
load("src/transport/reconstruct.js");
load("src/transport/orchestration.js");

const Gage = sandbox.window.Gage;
const { protocol, orchestration } = Gage;

let passed = 0;
function ok(name) {
  passed++;
  console.log("  ok  - " + name);
}

// Authentic thread fixtures, built through the real protocol so the test can't
// drift from the tweet grammar. WHITE challenges BLACK with 1.e4; replies carry
// one SAN each.
const WHITE = "white_player";
const BLACK = "black_player";
const OUTSIDER = "some_spectator";

const CHALLENGE = protocol.formatMove({
  gameId: "chess",
  moveText: "e4",
  opponentHandle: BLACK,
  isChallenge: true,
});
const reply = (san) => protocol.formatMove({ moveText: san, isChallenge: false });

// ---- 1. Black-to-move (root only: after 1.e4 it's Black's turn) -----------
(function blackToMove() {
  const texts = [CHALLENGE]; // only move 1 played
  const d = orchestration.decide(texts, { me: BLACK, rootAuthor: WHITE });

  assert.strictEqual(d.isGame, true, "root challenge => game mode");
  assert.strictEqual(d.gameId, "chess", "gameId from the root #chess");
  assert.strictEqual(d.white, WHITE, "white == root author");
  assert.strictEqual(d.black, BLACK, "black == first non-author @mention");
  assert.strictEqual(d.turn, "b", "after 1.e4 it's Black to move");
  assert.strictEqual(d.myColor, "b", "me is the black player");
  assert.strictEqual(d.over, false, "game not over");
  assert.strictEqual(d.error, null, "no desync");
  assert.strictEqual(d.interactive, true, "my (Black) turn on a clean board => interactive");
  assert.strictEqual(d.opponent, WHITE, "opponent is White");
  ok("Black-to-move: black player is interactive after 1.e4");
})();

// ---- 2. not-your-turn: White, same position, must be read-only ------------
(function whiteWaiting() {
  const texts = [CHALLENGE];
  const d = orchestration.decide(texts, { me: WHITE, rootAuthor: WHITE });

  assert.strictEqual(d.myColor, "w", "me is White");
  assert.strictEqual(d.turn, "b", "still Black to move");
  assert.strictEqual(d.interactive, false, "not my turn => not interactive");
  assert.ok(/waiting/i.test(d.status), "status says we're waiting");
  ok("not-your-turn: White is read-only while Black is to move");
})();

// ---- 3. White-to-move (root + Black's reply: back to White) ---------------
(function whiteToMove() {
  const texts = [CHALLENGE, reply("e5")]; // 1.e4 e5 -> White to move
  const d = orchestration.decide(texts, { me: WHITE, rootAuthor: WHITE });

  assert.strictEqual(d.turn, "w", "after 1.e4 e5 it's White to move");
  assert.strictEqual(d.myColor, "w", "me is White");
  assert.strictEqual(d.moveCount, 2, "two moves replayed");
  assert.strictEqual(d.interactive, true, "my (White) turn on a clean board => interactive");
  assert.strictEqual(d.opponent, BLACK, "opponent is Black");
  ok("White-to-move: white player is interactive after 1.e4 e5");
})();

// ---- 4. spectator: neither handle -> null color, never interactive --------
(function spectator() {
  const texts = [CHALLENGE, reply("e5")];
  const d = orchestration.decide(texts, { me: OUTSIDER, rootAuthor: WHITE });

  assert.strictEqual(d.isGame, true, "still a game to a spectator");
  assert.strictEqual(d.myColor, null, "outsider has no color");
  assert.strictEqual(d.interactive, false, "spectator is never interactive");
  assert.ok(/spectat/i.test(d.status), "status says spectating");
  ok("spectator: outside handle is read-only with no color");
})();

// ---- 4b. logged-out (me == null) is a spectator too -----------------------
(function loggedOut() {
  const d = orchestration.decide([CHALLENGE], { me: null, rootAuthor: WHITE });
  assert.strictEqual(d.myColor, null, "no me => no color");
  assert.strictEqual(d.interactive, false, "logged-out is read-only");
  ok("logged-out viewer is treated as a spectator");
})();

// ---- 5. desync: an illegal reply freezes the board read-only --------------
(function desync() {
  // 1.e4 then an illegal Black move ("Bb4" is unreachable) -> error at index 1,
  // state frozen after 1.e4 (Black to move). Even though it's "Black's turn",
  // a desynced thread must NOT be interactive for anyone.
  const texts = [CHALLENGE, reply("Bb4")];
  const d = orchestration.decide(texts, { me: BLACK, rootAuthor: WHITE });

  assert.ok(d.error, "an error is reported");
  assert.strictEqual(d.error.index, 1, "error points at the bad reply (index 1)");
  assert.strictEqual(d.error.moveText, "Bb4", "error carries the offending SAN");
  assert.strictEqual(d.moveCount, 1, "only 1.e4 applied");
  assert.strictEqual(d.turn, "b", "frozen position is Black to move");
  assert.strictEqual(d.interactive, false, "desync => read-only even on 'my' turn");
  assert.ok(/desync/i.test(d.status), "status announces the desync");
  ok("desync: illegal reply freezes the board read-only for everyone");
})();

// ---- 6. game over: checkmate => not interactive, result reported ----------
(function gameOver() {
  // Fool's mate: 1.f3 e5 2.g4 Qh4# — Black mates. Build it as a real thread.
  const texts = [
    protocol.formatMove({ gameId: "chess", moveText: "f3", opponentHandle: BLACK, isChallenge: true }),
    reply("e5"),
    reply("g4"),
    reply("Qh4#"),
  ];
  const d = orchestration.decide(texts, { me: WHITE, rootAuthor: WHITE });

  assert.strictEqual(d.over, true, "checkmate => game over");
  assert.strictEqual(d.result, "b", "Black delivered mate");
  assert.strictEqual(d.interactive, false, "no moves after game over");
  assert.ok(/game over/i.test(d.status), "status says game over");
  ok("game over: checkmate ends interactivity and reports the winner");
})();

// ---- 7. practice / non-Gage page: not a game ------------------------------
(function practice() {
  // A normal timeline: no #gage root. decide() must bail to practice.
  const d1 = orchestration.decide(["good morning everyone ☀️", "nice"], { me: WHITE, rootAuthor: "someone" });
  assert.strictEqual(d1.isGame, false, "non-Gage root => not a game");
  assert.strictEqual(d1.gameId, null, "no gameId off a game thread");

  // A #gage REPLY as the first tweet (no game tag) is NOT a game root either.
  const d2 = orchestration.decide([reply("e4")], { me: WHITE, rootAuthor: WHITE });
  assert.strictEqual(d2.isGame, false, "a reply-shaped root (no #chess) isn't a game");

  // Empty thread.
  const d3 = orchestration.decide([], { me: WHITE, rootAuthor: null });
  assert.strictEqual(d3.isGame, false, "empty thread => not a game");
  ok("practice: non-Gage / reply-only / empty roots are not games");
})();

// ---- 8. mention-parsing helper edge cases ---------------------------------
(function mentions() {
  // Root author self-mention is skipped; the first OTHER @handle is Black.
  const rootText = "♟ rematch @white_player vs @black_player #gage #chess [e4]";
  assert.strictEqual(
    orchestration.firstRivalMention(rootText, WHITE),
    BLACK,
    "skips the author's own @mention, picks the rival"
  );
  const d = orchestration.decide([rootText], { me: BLACK, rootAuthor: WHITE });
  assert.strictEqual(d.black, BLACK, "black resolved past an author self-mention");
  ok("mentions: author self-mention is skipped when resolving Black");
})();

console.log("\nAll orchestration tests passed (" + passed + " checks).");
