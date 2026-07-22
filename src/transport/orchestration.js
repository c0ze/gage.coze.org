// Game-play orchestration DECISION layer. PURE / DOM-independent.
//
// This is the brain of the content script, factored out so it can be unit-tested
// without a live X page. Given the RAW tweet texts of a conversation (thread
// order, root first) and the two identity handles the DOM layer reads
// (`me` = logged-in user, `rootAuthor` = author of the root tweet), it decides
// everything content.js needs to render one frame of a Gage game:
//
//   Gage.orchestration.decide(rawPosts, { me, rootAuthor }) -> Decision
//
//   rawPosts: EITHER string[] (legacy — raw post texts, author unknown) OR
//   { text, author }[] where author is the post's lowercased handle or null
//   when the DOM couldn't read it (adapters' readThreadPosts()). Authorship
//   gates which posts count as MOVES (see AUTHORSHIP below).
//
//   Decision = {
//     isGame     : boolean   the thread's ROOT parses to a #gage move with a
//                            KNOWN gameId -> this is a Gage game thread.
//     gameId     : string|null   the declared game ("chess"), or null if not a game.
//     white      : string|null   WHITE handle == rootAuthor (challenger), lowercased.
//     black      : string|null   BLACK handle == first @mention in the ROOT text
//                                 that isn't the root author, lowercased — REFINED
//                                 to the exact handle of the player who actually
//                                 claimed/locked the side once they have moved
//                                 (see collectMovePosts' identity locks).
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
  //
  // Handles are platform-shaped and MUST match what the transport adapters return
  // from getMyHandle/getRootAuthorHandle:
  //   X        -> [A-Za-z0-9_]           ("arda")
  //   Bluesky  -> DNS-style, dots/hyphens ("rival.bsky.social")
  //   Mastodon -> local "user" OR remote "user@instance.tld"
  // So we capture an initial [A-Za-z0-9_.-] run, then an OPTIONAL "@instance" tail
  // (Mastodon remote), and strip any trailing "." / "-" that sentence punctuation
  // may glue on (e.g. "@rival." at the end of a clause).
  function mentionsOf(text) {
    const out = [];
    if (typeof text !== "string") return out;
    // Lookbehind: the leading "@" must START a mention (preceded by start-of-text
    // or a non-handle char), so an email's domain ("a@b.com") is NOT misread as a
    // mention of "b.com". The optional "@instance" tail (Mastodon) is inside the
    // capture, so remote handles still parse whole.
    const re = /(?<![A-Za-z0-9_.@\-])@([A-Za-z0-9_][A-Za-z0-9_.\-]*(?:@[A-Za-z0-9_][A-Za-z0-9_.\-]*)?)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const h = m[1].toLowerCase().replace(/[.\-]+$/, "");
      if (h) out.push(h);
    }
    return out;
  }

  function firstRivalMention(rootText, rootAuthor) {
    for (const h of mentionsOf(rootText)) {
      // Skip a mention of the AUTHOR — including a short self-mention when the read
      // rootAuthor is a full handle (handleMatch's bare-vs-qualified rule). A
      // genuinely different full-handle rival is NOT skipped (both-qualified => exact).
      if (h && !handleMatch(h, rootAuthor)) return h;
    }
    return null;
  }

  function norm(h) {
    return h == null ? null : String(h).replace(/^@/, "").toLowerCase() || null;
  }

  // The "local part" of a handle: the label before the first "." or "@". Platforms
  // suffix handles differently — Bluesky is "gand-tr.bsky.social", Mastodon remote
  // is "user@instance.tld" — yet a challenge may @-mention the bare "gand-tr" while
  // getMyHandle reads the full handle. Comparing local parts lets a short mention
  // still identify the same player. (X handles have no suffix, so they still match
  // exactly and are unaffected.)
  function localPart(h) {
    return String(h == null ? "" : h).split(/[.@]/)[0];
  }
  // A BARE handle has no domain/instance suffix (no "." or "@") — e.g. a short
  // "@gand-tr" mention, as opposed to the full "gand-tr.bsky.social".
  function isBare(h) {
    return h.indexOf(".") === -1 && h.indexOf("@") === -1;
  }
  // Same person if identical, OR one side is a BARE handle whose local part matches
  // the other's. We fall back to local-part matching ONLY when exactly one side is
  // bare (a short mention vs a full handle); two DIFFERENT fully-qualified handles
  // that merely share a local part ("gand-tr.bsky.social" vs "gand-tr.example.com")
  // must NOT collide, so both-qualified requires exact equality.
  function handleMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (isBare(a) === isBare(b)) return false; // both bare (would be ===) or both qualified
    const la = localPart(a);
    return !!la && la === localPart(b);
  }

  function colorName(c) {
    return c === "w" ? "White" : c === "b" ? "Black" : "?";
  }

  function atOr(handle, fallback) {
    return handle ? "@" + handle : fallback;
  }

  // Normalize decide()'s input: a string item is a bare text (legacy adapters /
  // callers — author unknown), an object item is { text, author } from
  // readThreadPosts(). Anything malformed degrades to empty-text/null-author so
  // a half-hydrated post can never throw here.
  function normalizePosts(rawPosts) {
    const items = Array.isArray(rawPosts) ? rawPosts : [];
    return items.map(function (it) {
      if (typeof it === "string") return { text: it, author: null };
      if (it && typeof it === "object") {
        return {
          text: typeof it.text === "string" ? it.text : "",
          author: norm(it.author),
        };
      }
      return { text: "", author: null };
    });
  }

  // AUTHORSHIP: collect the thread's MOVE list, gated by who posted each move.
  // Sides strictly alternate — the Nth accepted move belongs to white when N is
  // even (white == rootAuthor posts the root move), black when odd.
  //
  // Each side has an identity LOCK — the exact author string the side is pinned
  // to. BOTH sides start unlocked. WHITE may bridge (handleMatch's short-vs-full
  // rule) ONLY at the ROOT post: rootAuthor and the root's per-post author are
  // read off the SAME first post, so a form gap can only exist there — a LATER
  // white slot with the side still unlocked requires the exact mentioned string,
  // or a federated lookalike ("alice@evil.example" impersonating a bare "alice")
  // could steal White while the root's author is unreadable. BLACK starts
  // unlocked with only the root MENTION to go by (possibly a short form like
  // "@gand-tr" for "gand-tr.bsky.social"): the first READABLE author that
  // handleMatches the mention claims the side and locks it, so from then on
  // lookalikes are rejected exactly too. When a side has no mention at all (no
  // rival resolved), the first readable poster of that side's slot claims it.
  //
  // A post that parses as a move is accepted only if:
  //   (a) its author is null — the DOM couldn't read it (legacy string[] input,
  //       or a hydration gap). Trusting these keeps old threads / half-loaded
  //       pages replayable (pre-authorship behavior); such a move never locks
  //       or re-keys a side; or
  //   (b) its side is LOCKED and the author is exactly the locked string; or
  //   (c) its side is unlocked and the author handleMatches the side's mention
  //       (or the side has no mention) — the author then locks the side.
  // Anything else — a bystander's "[e5] #gage", troll bracketed chatter, the
  // same player posting twice in a row — is SKIPPED as chatter, NOT a desync:
  // the game simply doesn't see it.
  //
  // Residual (documented) limit: when the challenge mentions a BARE handle, the
  // FIRST black move is the only slot a lookalike could claim (the short form
  // can't pin an instance); a full-handle mention closes even that.
  //
  // collectMovePosts returns { moves: [{ index, moveText, author }], locks:
  // { w, b } } — moves so callers can recover WHICH post carries the last
  // accepted move (reply targeting), locks so decide() can refine the sides to
  // the players who ACTUALLY own them (e.g. black resolved from a short mention
  // to the full handle of the player who claimed the side, or a side with no
  // mention at all claimed by its first poster).
  function collectMovePosts(posts, protocol, white, black) {
    const out = [];
    // BOTH sides start unlocked and bridge through handleMatch on first claim.
    // White previously pre-locked to the exact rootAuthor string, but the root
    // author read (getRootAuthorHandle) and the per-post author read
    // (readThreadPosts) can disagree in FORM — short vs full handle across a
    // hydration race — and an exact pre-lock would then reject WHITE'S OWN
    // moves (resetting the game to move one). handleMatch keeps the same
    // instance-collision guard (two qualified handles must be equal) and the
    // side still pins to the claimant's exact string afterward.
    const lock = { w: null, b: null };
    const mention = { w: white, b: black };
    for (let i = 0; i < posts.length; i++) {
      const parsed = protocol.parseMove(posts[i].text);
      if (!parsed) continue; // not a move-shaped post at all
      const side = out.length % 2 === 0 ? "w" : "b";
      const author = posts[i].author;
      if (author != null) {
        if (lock[side] != null) {
          if (author !== lock[side]) continue; // locked side: exact author only
        } else if (mention[side] != null) {
          // WHITE may bridge (short vs full form) ONLY at the root post: the
          // rootAuthor and the root post's author are read off the SAME first
          // post, so a form gap can only exist there. On a LATER white slot
          // (root author unreadable) a bridged claim would let a federated
          // lookalike of a bare rootAuthor steal White — require exact.
          if (side === "w" && i > 0) {
            if (author !== mention.w) continue; // wrong player (no late bridging)
          } else if (!handleMatch(author, mention[side])) {
            continue; // wrong player
          }
          lock[side] = author; // first readable rightful owner pins the side
        } else {
          lock[side] = author; // no mention to check — first readable poster claims it
        }
      }
      out.push({ index: i, moveText: parsed.moveText, author: author });
    }
    return { moves: out, locks: lock };
  }

  function collectMoveTexts(posts, protocol, white, black) {
    return collectMovePosts(posts, protocol, white, black).moves.map(function (p) {
      return p.moveText;
    });
  }

  // lastAcceptedMoveIndex(rawPosts) -> index (into rawPosts) of the LAST post
  // accepted as a move under the same authorship gate decide() uses, or -1.
  // The DOM adapters use this to pick the REPLY TARGET, so a skipped outsider's
  // "[e5] #gage" can never become the parent of the next legitimate move (which
  // would fork the chain / redirect notifications to the outsider).
  function lastAcceptedMoveIndex(rawPosts) {
    const protocol = Gage.protocol;
    const posts = normalizePosts(rawPosts);
    if (!protocol || !protocol.parseMove || !posts.length) return -1;
    const white = posts[0].author;
    const black = firstRivalMention(posts[0].text, white);
    const accepted = collectMovePosts(posts, protocol, white, black).moves;
    return accepted.length ? accepted[accepted.length - 1].index : -1;
  }

  // decide(rawPosts, { me, rootAuthor }) -> Decision  (see header).
  function decide(rawPosts, ids) {
    const posts = normalizePosts(rawPosts);
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

    const rootText = posts.length ? posts[0].text : "";
    const rootParse = protocol.parseMove(rootText);

    // GAME MODE gate: the ROOT must parse to a #gage move that DECLARES a known
    // game (a challenge carries "#chess"). A reply-shaped root (no gameId) or a
    // non-Gage root is not a game thread we can host. (The root's author IS
    // rootAuthor by construction — the DOM layer reads both off the same first
    // post — so no separate root-authorship check is needed here.)
    const gameId = rootParse && rootParse.gameId ? rootParse.gameId : null;
    const game = gameId ? games[gameId] : null;
    if (!rootParse || !gameId || !game) return base;

    // Sides. WHITE = root author (challenger); BLACK = first @mention in the ROOT
    // text that isn't the root author. Resolved BEFORE collecting moves because
    // authorship gating needs to know whose turn each move slot belongs to.
    const blackMention = firstRivalMention(rootText, white);

    // The thread IS the move list: walk the posts in order, keep only the moves
    // posted by the RIGHT player for each alternating slot (see collectMovePosts),
    // then replay to the current position.
    const collected = collectMovePosts(posts, protocol, white, blackMention);
    const moveTexts = collected.moves.map(function (p) { return p.moveText; });
    const rebuilt = reconstruct(game, moveTexts);
    const state = rebuilt && rebuilt.state ? rebuilt.state : game.initialState();
    const error = (rebuilt && rebuilt.error) || null;

    // REFINE the sides with the identity locks learned while collecting: the
    // lock is the exact author string of the player ACTUALLY posting a side's
    // moves — the mention may be a short form ("gand-tr" for the full
    // "gand-tr.bsky.social"), absent entirely (black claimed by its first
    // poster), or, once a rightful player has locked the side, more specific
    // than the mention (so a federated lookalike of a bare mention no longer
    // handleMatches into myColor/interactivity). Fall back to the raw
    // rootAuthor/mention when a side never locked (e.g. no moves yet).
    const whiteId = collected.locks.w != null ? collected.locks.w : white;
    const black = collected.locks.b != null ? collected.locks.b : blackMention;

    const myColor =
      me && handleMatch(me, whiteId) ? "w" : me && handleMatch(me, black) ? "b" : null;

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
    const opponent = myColor === "w" ? black : myColor === "b" ? whiteId : null;

    const status = statusFor({
      error: error,
      over: over,
      result: result,
      myColor: myColor,
      turn: turn,
      white: whiteId,
      black: black,
      opponent: opponent,
    });

    return {
      isGame: true,
      gameId: gameId,
      white: whiteId,
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
    handleMatch: handleMatch,
    collectMovePosts: collectMovePosts,
    collectMoveTexts: collectMoveTexts,
    lastAcceptedMoveIndex: lastAcceptedMoveIndex,
    normalizePosts: normalizePosts,
  };
})();
