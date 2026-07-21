// Tweet <-> move protocol. PURE / transport-independent (no DOM, no X APIs).
// window.Gage.protocol builds and parses the text of a single move-carrying
// tweet. The DOM layer (thread-dom.js) supplies the tweet strings; this module
// never touches the page.
//
// ============================================================================
// TWEET GRAMMAR  (exact, human-tolerant)
// ----------------------------------------------------------------------------
// Transport = PUBLIC THREADED REPLIES on X. One move == one tweet. State is NOT
// carried in any tweet (a full seed won't fit in ~280 chars); the ordered list
// of move tokens parsed from the reply chain IS the game (see reconstruct.js).
//
// Two tweet forms, both detected by the MARKER hashtag and both carrying exactly
// ONE move token in a canonical bracket slot:
//
//   MARKER    := "#gage"                         (literal; presence => Gage tweet)
//   MOVE-SLOT := "[" <moveText> "]"              (the ONLY authoritative move src)
//   GAME-TAG  := "#" <gameId>                    (e.g. "#chess"; challenge only)
//
//   ROOT / CHALLENGE tweet  (declares the game + carries move 1):
//       <free human text> #gage #<gameId> [<moveText>] <free human text>
//     e.g.  ♟ Chess challenge @rival — your move. #gage #chess [e4]
//
//   REPLY tweet  (one move; game already established by the root):
//       <free human text> #gage [<moveText>]
//     e.g.  [Nf6] #gage
//
// PARSING RULES (parseMove):
//   * No MARKER anywhere  -> not a Gage tweet -> null.
//   * moveText  = contents of the FIRST "[...]" slot (trimmed, non-empty).
//                 The brackets make extraction unambiguous even when the tweet
//                 also contains "@handles", "#hashtags", emoji, or prose.
//   * gameId    = the first "#<token>" that is a KNOWN game hashtag and is not
//                 the marker itself. Present on challenges; omitted on replies
//                 (undefined => "same game as the thread root").
//   * A tweet with the MARKER but no valid "[...]" slot -> null (it's chatter in
//                 the thread, not a move). Reconstruction skips such tweets.
//
// The move token is the game's human move text (chess: SAN like "Nf3", "O-O",
// "exd6", "e8=Q", "Qh7#"). SAN's own "#"/"+"/"=" never break parsing because the
// authoritative token lives inside the brackets; the marker is matched as the
// exact substring "#gage".
// ============================================================================
(function () {
  const Gage = (window.Gage = window.Gage || {});

  const MARKER = "#gage";

  // First "[...]" slot, captured non-greedily so "[Nf3] ... [x]" takes "Nf3".
  const SLOT_RE = /\[([^\]]+)\]/;

  // Known game hashtags -> gameId. Kept explicit (not "any #word") so ordinary
  // hashtags in prose ("#chessisfun") aren't mistaken for a game declaration.
  const GAME_TAGS = { "#chess": "chess" };

  // A standalone MARKER ANYWHERE in the text: bounded left (start/non-word) and
  // right (end/non-word), so "#gagexyz" or "word#gage" don't match, but a valid
  // "#gage" later in the SAME tweet still does. (Checking only the first "#gage"
  // occurrence wrongly rejected "#gagexyz … #gage".)
  const MARKER_RE = new RegExp(
    "(^|[^0-9A-Za-z_])" + MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![0-9A-Za-z_])"
  );
  function hasMarker(text) {
    return typeof text === "string" && MARKER_RE.test(text);
  }

  // formatMove({ gameId, moveText, opponentHandle?, isChallenge }) -> string
  // Challenge form declares the game and carries move 1; reply form is terse.
  // Both always contain MARKER and the move in a "[...]" slot parseMove can read.
  function formatMove(opts) {
    opts = opts || {};
    const moveText = String(opts.moveText == null ? "" : opts.moveText).trim();
    const gameId = opts.gameId || "chess";
    const slot = "[" + moveText + "]";
    if (opts.isChallenge) {
      const gameTag = "#" + gameId;
      const mention = opts.opponentHandle
        ? " " + normalizeHandle(opts.opponentHandle)
        : "";
      // Human-facing challenge; machine reads the marker, game tag, and slot.
      return (
        "♟ " + cap(gameId) + " challenge" + mention +
        " — your move. " + MARKER + " " + gameTag + " " + slot
      );
    }
    // Terse reply: the move, then the marker so it's detectable in the thread.
    return slot + " " + MARKER;
  }

  // parseMove(tweetText) -> { moveText, gameId? } | null
  // null if the tweet is not a Gage move tweet (no marker, or no move slot).
  function parseMove(tweetText) {
    if (typeof tweetText !== "string" || !hasMarker(tweetText)) return null;
    const m = SLOT_RE.exec(tweetText);
    if (!m) return null; // marker present but no move slot => thread chatter
    const moveText = m[1].trim();
    if (!moveText) return null;
    const out = { moveText };
    const gameId = detectGame(tweetText);
    if (gameId) out.gameId = gameId; // omitted on replies (inherit from root)
    return out;
  }

  // First recognized game hashtag in the text, or null. Scans "#word" tokens and
  // matches them against GAME_TAGS (case-insensitive), skipping the marker.
  function detectGame(text) {
    const re = /#[A-Za-z0-9_]+/g;
    let hit;
    while ((hit = re.exec(text)) !== null) {
      const tag = hit[0].toLowerCase();
      if (tag === MARKER) continue;
      if (GAME_TAGS[tag]) return GAME_TAGS[tag];
    }
    return null;
  }

  function normalizeHandle(h) {
    h = String(h).trim();
    return h.charAt(0) === "@" ? h : "@" + h;
  }

  function cap(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  Gage.protocol = {
    MARKER,
    formatMove,
    parseMove,
    // exposed for tests / callers that want to register more games:
    GAME_TAGS,
  };
})();
