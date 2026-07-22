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

// ---- 9. cross-platform handle matching (short mention vs full handle) ------
(function crossPlatformHandles() {
  // Bluesky: the challenge @-mentions the bare "gand-tr" but the viewer's handle
  // (getMyHandle) is the full "gand-tr.bsky.social" — the player must still be
  // recognized (Black), not treated as a spectator.
  const bsky = protocol.formatMove({ gameId: "chess", moveText: "e4", opponentHandle: "gand-tr", isChallenge: true });
  const dB = orchestration.decide([bsky], { me: "gand-tr.bsky.social", rootAuthor: "arda-karaduman.bsky.social" });
  assert.strictEqual(dB.black, "gand-tr", "black resolves from the short mention");
  assert.strictEqual(dB.myColor, "b", "full handle matches the short mention (Bluesky)");
  assert.strictEqual(dB.interactive, true, "recognized player is interactive, not a spectator");

  // Mastodon: the author viewing their OWN thread reads a bare local "akaraduman"
  // while the post header shows "akaraduman@mastodon.social"; White must still match.
  const masto = protocol.formatMove({ gameId: "chess", moveText: "e4", opponentHandle: "gandtr", isChallenge: true });
  const dW = orchestration.decide([masto], { me: "akaraduman", rootAuthor: "akaraduman@mastodon.social" });
  assert.strictEqual(dW.myColor, "w", "bare local handle matches the full author handle (Mastodon)");

  // Safety: two DIFFERENT fully-qualified handles that merely share a local part must
  // NOT collide — a lookalike on another instance stays a spectator.
  const full = protocol.formatMove({ gameId: "chess", moveText: "e4", opponentHandle: "gand-tr.bsky.social", isChallenge: true });
  const dLook = orchestration.decide([full], { me: "gand-tr.example.com", rootAuthor: "arda-karaduman.bsky.social" });
  assert.strictEqual(dLook.myColor, null, "different qualified handles sharing a local part don't collide");
  ok("handle matching: short mention <-> full handle across platforms, no cross-instance false match");
})();

// ---- 10. AUTHORSHIP: an outsider's move-shaped reply is SKIPPED ------------
(function outsiderMoveSkipped() {
  // Board after 1.e4: Black to move. An OUTSIDER posts a perfectly valid-looking
  // "[e5] #gage" — under text-only parsing this would PLAY Black's move. With
  // authorship it must be skipped: the position stays at 1.e4, Black to move,
  // no desync, and the real Black player is still the one who's interactive.
  const posts = [
    { text: CHALLENGE, author: WHITE },
    { text: reply("e5"), author: OUTSIDER },
  ];
  const d = orchestration.decide(posts, { me: BLACK, rootAuthor: WHITE });

  assert.strictEqual(d.error, null, "outsider move is chatter, not a desync");
  assert.strictEqual(d.moveCount, 1, "only the root move applied");
  assert.strictEqual(d.turn, "b", "still Black to move");
  assert.strictEqual(d.interactive, true, "real Black player still gets the turn");
  ok("authorship: outsider's '[e5] #gage' is skipped, board unchanged");
})();

// ---- 11. AUTHORSHIP: same player twice in a row -> second skipped ----------
(function doubleMoveSkipped() {
  // White posts the root (1.e4) and then ANOTHER move without waiting: the
  // second is out-of-turn (Black's slot) and must be skipped as chatter.
  const posts = [
    { text: CHALLENGE, author: WHITE },
    { text: reply("d4"), author: WHITE }, // out of turn — Black's slot
  ];
  const d = orchestration.decide(posts, { me: WHITE, rootAuthor: WHITE });

  assert.strictEqual(d.error, null, "out-of-turn own move isn't a desync");
  assert.strictEqual(d.moveCount, 1, "second consecutive move not applied");
  assert.strictEqual(d.turn, "b", "still Black's turn");
  assert.strictEqual(d.interactive, false, "White can't act on Black's turn");
  ok("authorship: a player's second consecutive move is skipped");
})();

// ---- 12. AUTHORSHIP: author null (unreadable) is accepted — legacy ---------
(function nullAuthorAccepted() {
  // Hydration gaps / legacy adapters yield author:null. Those moves must still
  // replay so half-loaded pages and old flows keep working.
  const posts = [
    { text: CHALLENGE, author: WHITE },
    { text: reply("e5"), author: null }, // unreadable — trusted
    { text: reply("Nf3"), author: WHITE },
  ];
  const d = orchestration.decide(posts, { me: BLACK, rootAuthor: WHITE });

  assert.strictEqual(d.error, null, "no desync with an unreadable author");
  assert.strictEqual(d.moveCount, 3, "null-author move accepted (1.e4 e5 2.Nf3)");
  assert.strictEqual(d.turn, "b", "back to Black after 2.Nf3");
  ok("authorship: author:null moves are accepted (hydration-gap tolerance)");
})();

// ---- 13. AUTHORSHIP: troll bracketed chatter by an outsider ----------------
(function trollChatterSkipped() {
  // "[lol nice game] #gage" from a bystander used to hard-DESYNC the thread
  // (unparseable move token stops reconstruction). With authorship it never
  // reaches the move list; the game continues cleanly around it.
  const posts = [
    { text: CHALLENGE, author: WHITE },
    { text: "[lol nice game] #gage", author: OUTSIDER },
    { text: reply("e5"), author: BLACK },
  ];
  const d = orchestration.decide(posts, { me: WHITE, rootAuthor: WHITE });

  assert.strictEqual(d.error, null, "troll chatter causes no desync");
  assert.strictEqual(d.moveCount, 2, "1.e4 e5 replayed around the troll post");
  assert.strictEqual(d.turn, "w", "White to move");
  assert.strictEqual(d.interactive, true, "game continues for the real players");
  ok("authorship: outsider's bracketed chatter can no longer desync the board");
})();

// ---- 14. AUTHORSHIP: short-mention vs full-handle authors still play -------
(function shortVsFullAuthors() {
  // Bluesky-style: the challenge mentions the bare "gand-tr", but the DOM reads
  // the poster's FULL handle "gand-tr.bsky.social". handleMatch must bridge the
  // two so the rightful Black's move is accepted, not skipped.
  const root = protocol.formatMove({
    gameId: "chess", moveText: "e4", opponentHandle: "gand-tr", isChallenge: true,
  });
  const posts = [
    { text: root, author: "arda-karaduman.bsky.social" },
    { text: reply("e5"), author: "gand-tr.bsky.social" },
  ];
  const d = orchestration.decide(posts, {
    me: "arda-karaduman.bsky.social",
    rootAuthor: "arda-karaduman.bsky.social",
  });

  assert.strictEqual(d.moveCount, 2, "full-handle author matches the short mention");
  assert.strictEqual(d.error, null, "no desync");
  assert.strictEqual(d.turn, "w", "White to move after 1.e4 e5");

  // When the challenge mentions the FULL handle, a lookalike from another
  // instance is rejected (both qualified -> exact match required). NOTE: a
  // BARE mention can't pin the instance — that's handleMatch's documented
  // trade-off for short mentions — so full-handle challenges are the strict form.
  const fullRoot = protocol.formatMove({
    gameId: "chess", moveText: "e4",
    opponentHandle: "gand-tr.bsky.social", isChallenge: true,
  });
  const posts2 = [
    { text: fullRoot, author: "arda-karaduman.bsky.social" },
    { text: reply("e5"), author: "gand-tr.example.com" }, // imposter, wrong instance
  ];
  const d2 = orchestration.decide(posts2, {
    me: "arda-karaduman.bsky.social",
    rootAuthor: "arda-karaduman.bsky.social",
  });
  assert.strictEqual(d2.moveCount, 1, "cross-instance lookalike's move is skipped");
  assert.strictEqual(d2.error, null, "and causes no desync");
  ok("authorship: short/full handle forms match; qualified lookalikes are rejected");
})();

// ---- 15. AUTHORSHIP: unknown expected side can't reject (no rival read) ----
(function unknownExpectedAccepts() {
  // If the root resolved NO rival mention (black unknown), there is no rightful
  // owner of the Black slots to defend — readable authors must not be rejected
  // against a null expectation, or such threads would freeze at move 1. The
  // first poster CLAIMS the side: the decision then names them as Black (so
  // they get myColor/interactivity) and the identity lock keeps others out.
  const noMentionRoot = "chess time! #gage #chess [e4]";
  const posts = [
    { text: noMentionRoot, author: WHITE },
    { text: reply("e5"), author: OUTSIDER }, // black unknown -> first poster claims it
  ];
  const d = orchestration.decide(posts, { me: WHITE, rootAuthor: WHITE });
  assert.strictEqual(d.moveCount, 2, "unknown expected side accepts the move");
  assert.strictEqual(d.black, OUTSIDER, "the claimant is surfaced as Black");

  // And the claimant is now a real player, not a spectator: it's White's turn
  // here, so from the claimant's viewpoint we just check the color assignment.
  const dc = orchestration.decide(posts, { me: OUTSIDER, rootAuthor: WHITE });
  assert.strictEqual(dc.myColor, "b", "the claimant gets Black's seat");

  // A DIFFERENT readable author can no longer take Black's next slot.
  const posts2 = posts.concat([
    { text: reply("Nf3"), author: WHITE },
    { text: reply("Nc6"), author: "someone_else" }, // locked out
  ]);
  const d2 = orchestration.decide(posts2, { me: WHITE, rootAuthor: WHITE });
  assert.strictEqual(d2.moveCount, 3, "post-claim, other authors are locked out");
  ok("authorship: an unclaimed side is claimed (and locked) by its first poster");
})();

// ---- 16. legacy string[] input still fully works ---------------------------
(function legacyStringsStillWork() {
  // The exact call shape content.js used before readThreadPosts existed. All
  // texts, no authors — every move-shaped post plays, including the troll's
  // (pre-fix behavior preserved for author-less input).
  const texts = [CHALLENGE, reply("e5"), reply("Nf3")];
  const d = orchestration.decide(texts, { me: WHITE, rootAuthor: WHITE });
  assert.strictEqual(d.isGame, true, "string[] input still recognized");
  assert.strictEqual(d.moveCount, 3, "all string moves replayed");
  assert.strictEqual(d.error, null, "no desync");
  assert.strictEqual(d.turn, "b", "Black to move after 2.Nf3");

  // Mixed input (strings + objects) is normalized item-by-item.
  const mixed = [CHALLENGE, { text: reply("e5"), author: BLACK }];
  const dm = orchestration.decide(mixed, { me: WHITE, rootAuthor: WHITE });
  assert.strictEqual(dm.moveCount, 2, "mixed string/object items both replay");
  ok("legacy: plain string[] (and mixed) input behaves exactly as before");
})();

// ---- 17. pure helpers: normalizePosts / collectMoveTexts / handleMatch -----
(function pureHelpers() {
  const np = orchestration.normalizePosts([
    "hi", { text: "yo", author: "@Some_One" }, { author: "x" }, null, 42,
  ]);
  assert.strictEqual(np.length, 5, "every item normalizes");
  assert.strictEqual(np[0].author, null, "string item -> author null");
  assert.strictEqual(np[1].author, "some_one", "author is normalized (no @, lowercase)");
  assert.strictEqual(np[2].text, "", "missing text -> empty string");
  assert.strictEqual(np[3].text, "", "null item -> empty text");
  assert.strictEqual(np[4].author, null, "non-object item -> author null");

  assert.strictEqual(orchestration.handleMatch("gand-tr", "gand-tr.bsky.social"), true,
    "bare vs qualified handle matches on local part");
  assert.strictEqual(orchestration.handleMatch("gand-tr.example.com", "gand-tr.bsky.social"), false,
    "two different qualified handles never match");

  // Refined sides: once the full-handle player claims the short-mention seat,
  // the decision surfaces the FULL handle (and the lookalike loses myColor).
  const claimRoot = protocol.formatMove({
    gameId: "chess", moveText: "e4", opponentHandle: "gand-tr", isChallenge: true,
  });
  const dRef = orchestration.decide(
    [
      { text: claimRoot, author: "arda.bsky.social" },
      { text: reply("e5"), author: "gand-tr.bsky.social" },
    ],
    { me: "gand-tr.example.com", rootAuthor: "arda.bsky.social" }
  );
  assert.strictEqual(dRef.black, "gand-tr.bsky.social",
    "decision.black is refined to the locked full handle");
  assert.strictEqual(dRef.myColor, null,
    "a qualified lookalike no longer matches the refined Black");

  const moves = orchestration.collectMoveTexts(
    [
      { text: CHALLENGE, author: WHITE },
      { text: "gl hf!", author: OUTSIDER },            // not move-shaped
      { text: reply("e5"), author: OUTSIDER },          // wrong author
      { text: reply("e5"), author: BLACK },             // the real move
      { text: reply("Nf3"), author: BLACK },            // out of turn (White's slot)
      { text: reply("Nf3"), author: null },             // unreadable -> trusted
    ],
    protocol, WHITE, BLACK
  );
  // JSON-compare: the array was built inside the vm realm, so deepStrictEqual's
  // prototype check would fail cross-realm even on identical values.
  assert.strictEqual(JSON.stringify(moves), JSON.stringify(["e4", "e5", "Nf3"]),
    "gated move list in order");
  ok("pure helpers: normalizePosts / handleMatch / collectMoveTexts");
})();

// ---- 18. AUTHORSHIP: identity locks defeat federated lookalikes ------------
(function identityLocks() {
  // WHITE lock: the root author reads as local "alice"; a federated lookalike
  // "alice@evil.example" would PASS handleMatch's bare-vs-qualified bridge, but
  // a locked side requires the EXACT author string — the hijack move is skipped.
  const root = protocol.formatMove({
    gameId: "chess", moveText: "e4", opponentHandle: "bob", isChallenge: true,
  });
  const whiteImposter = orchestration.decide(
    [
      { text: root, author: "alice" },
      { text: reply("e5"), author: "bob" },
      { text: reply("Nf3"), author: "alice@evil.example" }, // white-slot hijack
    ],
    { me: "alice", rootAuthor: "alice" }
  );
  assert.strictEqual(whiteImposter.moveCount, 2, "white lookalike's move skipped");
  assert.strictEqual(whiteImposter.error, null, "and causes no desync");
  assert.strictEqual(whiteImposter.turn, "w", "still the real White's turn");

  // BLACK lock: the bare mention "bob" is claimed by the first rightful reader
  // ("bob" himself); afterwards "bob@evil.example" — who would ALSO handleMatch
  // the bare mention — is rejected by the exact lock.
  const blackImposter = orchestration.decide(
    [
      { text: root, author: "alice" },
      { text: reply("e5"), author: "bob" },          // locks black to "bob"
      { text: reply("Nf3"), author: "alice" },
      { text: reply("Nc6"), author: "bob@evil.example" }, // black-slot hijack
    ],
    { me: "alice", rootAuthor: "alice" }
  );
  assert.strictEqual(blackImposter.moveCount, 3, "black lookalike's move skipped after lock");
  assert.strictEqual(blackImposter.error, null, "no desync from the lookalike");
  assert.strictEqual(blackImposter.turn, "b", "still the real Black's turn");
  ok("authorship: per-side identity locks reject federated lookalikes mid-game");
})();

// ---- 19. lastAcceptedMoveIndex: reply target skips outsider move posts -----
(function replyTargetIndex() {
  // Thread: root move (0), chatter (1), Black's move (2), outsider's parseable
  // fake (3), plain chatter (4). The reply target must be index 2 — the last
  // ACCEPTED move — never the outsider's post (3) or trailing chatter (4).
  const posts = [
    { text: CHALLENGE, author: WHITE },
    { text: "good luck!", author: OUTSIDER },
    { text: reply("e5"), author: BLACK },
    { text: reply("d4"), author: OUTSIDER }, // parseable but rejected
    { text: "wow tense", author: OUTSIDER },
  ];
  assert.strictEqual(orchestration.lastAcceptedMoveIndex(posts), 2,
    "target is the last ACCEPTED move post");
  assert.strictEqual(orchestration.lastAcceptedMoveIndex([]), -1, "empty -> -1");
  assert.strictEqual(
    orchestration.lastAcceptedMoveIndex([{ text: "hi", author: "a" }]),
    -1,
    "no move-shaped post -> -1"
  );
  // Legacy string[] shape works here too (authors unknown -> trusted).
  assert.strictEqual(
    orchestration.lastAcceptedMoveIndex([CHALLENGE, "nice", reply("e5")]),
    2,
    "string[] input: last parseable is last accepted"
  );
  ok("lastAcceptedMoveIndex: outsider posts can't become the reply target");
})();

console.log("\nAll orchestration tests passed (" + passed + " checks).");
