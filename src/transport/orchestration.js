// Game-play orchestration DECISION layer. PURE / DOM-independent.
//
// This is the brain of the content script, factored out so it can be unit-tested
// without a live X page. Given the RAW tweet texts of a conversation (thread
// order, root first) and the two identity handles the DOM layer reads
// (`me` = logged-in user, `rootAuthor` = author of the root tweet), it decides
// everything content.js needs to render one frame of a Gage game:
//
//   Gage.orchestration.decide(rawTexts, { me, rootAuthor }) -> Decision
//
//   Decision = {
//     isGame     : boolean   the thread's ROOT parses to a #gage move with a
//                            KNOWN gameId -> this is a Gage game thread.
//     gameId     : string|null   the declared game ("chess"), or null if not a game.
//     white      : string|null   WHITE handle == rootAuthor (challenger), lowercased.
//     black      : string|null   BLACK handle == first @mention in the ROOT text
//                                 that isn't the root author, lowercased.
//     me         : string|null   echo of the caller's `me` (lowercased).
//     myColor    : "w"|"b"|null  my side, or null when I'm a spectator.
//     state      : State|null    the reconstructed position (last-good on desync).
//     turn       : "w"|"b"|null  side to move at `state`.
//     moveCount  : number        moves successfully replayed.
//     over       : boolean       game finished at `state`.
//     result     : "w"|"b"|"draw"|null  terminal result when `over`.
//     error      : { index, moveText, reason }|null   first desync/illegal move.
//     interactive: boolean       true iff it's MY legal turn to post a move:
//                                 myColor && !error && !over && turn === myColor.
//     opponent   : string|null   the handle I'm waiting on (the other color).
//     status     : string        human status line ("your move", "waiting…", …).
//   }
//
// Purity: uses only window.Gage.{protocol, reconstruct, games} — all pure,
// already loaded ahead of this file by the manifest. No document / DOM access,
// so a node vm test can exercise every branch (see transport.test.js pattern).
(function () {
  const Gage = (window.Gage = window.Gage || {});

  // All @mentions in `text`, lowercased, in order. The BLACK player is the first
  // one that isn't the root author (the challenger @mentions their rival).
  function mentionsOf(text) {
    const out = [];
    if (typeof text !== "string") return out;
    const re = /@([A-Za-z0-9_]+)/g;
    let m;
    while ((m = re.exec(text)) !== null) out.push(m[1].toLowerCase());
    return out;
  }

  function firstRivalMention(rootText, rootAuthor) {
    for (const h of mentionsOf(rootText)) {
      if (h && h !== rootAuthor) return h;
    }
    return null;
  }

  function norm(h) {
    return h == null ? null : String(h).replace(/^@/, "").toLowerCase() || null;
  }

  function colorName(c) {
    return c === "w" ? "White" : c === "b" ? "Black" : "?";
  }

  function atOr(handle, fallback) {
    return handle ? "@" + handle : fallback;
  }

  // decide(rawTexts, { me, rootAuthor }) -> Decision  (see header).
  function decide(rawTexts, ids) {
    const texts = Array.isArray(rawTexts) ? rawTexts : [];
    ids = ids || {};
    const me = norm(ids.me);
    // WHITE is the root author. Prefer the caller-supplied rootAuthor (the DOM
    // layer reads it directly); fall back to null if absent.
    const white = norm(ids.rootAuthor);

    const protocol = Gage.protocol;
    const reconstruct = Gage.reconstruct;
    const games = Gage.games || {};

    // Base (non-game) decision; used for practice pages and unknown games.
    const base = {
      isGame: false,
      gameId: null,
      white: white,
      black: null,
      me: me,
      myColor: null,
      state: null,
      turn: null,
      moveCount: 0,
      over: false,
      result: null,
      error: null,
      interactive: false,
      opponent: null,
      status: "practice mode",
    };

    if (!protocol || !reconstruct) return base;

    const rootText = texts.length ? texts[0] : "";
    const rootParse = protocol.parseMove(rootText);

    // GAME MODE gate: the ROOT must parse to a #gage move that DECLARES a known
    // game (a challenge carries "#chess"). A reply-shaped root (no gameId) or a
    // non-Gage root is not a game thread we can host.
    const gameId = rootParse && rootParse.gameId ? rootParse.gameId : null;
    const game = gameId ? games[gameId] : null;
    if (!rootParse || !gameId || !game) return base;

    // The thread IS the move list: parse every tweet to its move token, drop
    // chatter / non-Gage tweets, then replay to the current position.
    const moveTexts = texts
      .map((t) => protocol.parseMove(t))
      .filter(Boolean)
      .map((p) => p.moveText);
    const rebuilt = reconstruct(game, moveTexts);
    const state = rebuilt && rebuilt.state ? rebuilt.state : game.initialState();
    const error = (rebuilt && rebuilt.error) || null;

    // Sides. WHITE = root author (challenger); BLACK = first @mention in the ROOT
    // text that isn't the root author.
    const black = firstRivalMention(rootText, white);
    const myColor = me && me === white ? "w" : me && me === black ? "b" : null;

    // Turn / termination read off the (last-good) reconstructed state.
    let turn = null;
    let over = false;
    let result = null;
    try {
      turn = game.turn(state);
      const term = game.terminal(state);
      over = !!term.over;
      result = term.result || null;
    } catch (e) {
      // A game module that throws on a hydrated state is itself a desync signal.
      turn = null;
    }

    // Interactive ONLY when it's my legal turn on a clean, unfinished game.
    const interactive = !!myColor && !error && !over && turn === myColor;
    const opponent = myColor === "w" ? black : myColor === "b" ? white : null;

    const status = statusFor({
      error: error,
      over: over,
      result: result,
      myColor: myColor,
      turn: turn,
      white: white,
      black: black,
      opponent: opponent,
    });

    return {
      isGame: true,
      gameId: gameId,
      white: white,
      black: black,
      me: me,
      myColor: myColor,
      state: state,
      turn: turn,
      moveCount: (rebuilt && rebuilt.moveCount) || 0,
      over: over,
      result: result,
      error: error,
      interactive: interactive,
      opponent: opponent,
      status: status,
    };
  }

  // Human status line — always says whose turn / what to do.
  function statusFor(d) {
    if (d.error) {
      return (
        "thread desync at move " + (d.error.index + 1) +
        " (" + d.error.moveText + ") — board is read-only"
      );
    }
    if (d.over) {
      const r =
        d.result === "draw"
          ? "draw"
          : colorName(d.result) + " wins";
      return "game over: " + r;
    }
    const toMove = d.turn === "w" ? d.white : d.black;
    if (d.myColor && d.turn === d.myColor) {
      return "your move (" + colorName(d.myColor) + ") — make it, then press Reply to send";
    }
    if (d.myColor) {
      return "waiting for " + atOr(d.opponent || toMove, "your opponent");
    }
    // Spectator.
    return "you're spectating — " + colorName(d.turn) + " to move (" + atOr(toMove, "?") + ")";
  }

  Gage.orchestration = {
    decide: decide,
    // exposed for tests / reuse:
    mentionsOf: mentionsOf,
    firstRivalMention: firstRivalMention,
  };
})();
