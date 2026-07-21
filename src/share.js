// Client share/upload helpers: turn the current position into (a) a shareable
// game-page seed and (b) an in-tweet board IMAGE cached on the Gage origin.
// PURE except uploadBoardImage (which does the network I/O). No DOM, no X APIs.
//
// This is the CLIENT half of the image contract. A Cloudflare Worker at
// SHARE_ORIGIN (later phase) serves GET /img/<key>.png and accepts PUT of the
// same, and serves the game page at GET /g/<seed>. Everything here builds URLs
// and payloads that match that worker exactly.
//
//   Gage.SHARE_ORIGIN                                      "https://gage.coze.org"
//   Gage.positionKey(gameModule, state)          -> string   visual-position key
//   Gage.gameUrl(seed)                           -> string   SHARE_ORIGIN/g/<seed>
//   Gage.imageUrl(key)                           -> string   SHARE_ORIGIN/img/<key>.png
//   Gage.buildShareSeed(gameModule, state, players) -> string  encoded seed+meta
//   Gage.uploadBoardImage(gameModule, state)     -> Promise<{key, uploaded?, skipped?, error?}>
//
// POSITION KEY — the image cache-key. It encodes the VISUAL position ONLY (the
// piece placement you can see), NOT whose turn it is, castling rights, or en
// passant. So two move orders that reach the same board (a transposition) yield
// the SAME key and reuse ONE cached image. A game module may provide its own
// canonical positionKey(state) (chess: FEN placement field, "/"->"-"); otherwise
// we derive a generic URL-safe ASCII key straight from view(state).
(function () {
  const Gage = (window.Gage = window.Gage || {});

  const SHARE_ORIGIN = "https://gage.coze.org";

  // ---- position key -------------------------------------------------------

  // Encode one Cell as a URL-safe ASCII token for the generic key:
  //   empty cell           -> "."
  //   piece                -> <color><glyph-codepoints>, color "w"/"b"/"x"
  // Glyphs may be non-ASCII (Unicode chess pieces), so we emit each glyph char's
  // code point in base36 joined by "." — pure [0-9a-z.] and thus URL-safe. The
  // token is a stable function of (color, glyph): identical cells => identical
  // tokens, which is all the key needs.
  function cellToken(cell) {
    if (!cell || !cell.glyph) return ".";
    const color = cell.color === "w" ? "w" : cell.color === "b" ? "b" : "x";
    let code = "";
    for (let i = 0; i < cell.glyph.length; i++) {
      code += (i ? "." : "") + cell.glyph.charCodeAt(i).toString(36);
    }
    return color + code;
  }

  // Generic key from view(state): encode every cell, join a row's tokens with
  // "_", join rows with "-". Result is URL-safe ASCII regardless of the glyph set.
  function genericKey(gameModule, state) {
    const cells = gameModule.view(state);
    const rowKeys = [];
    for (let r = 0; r < cells.length; r++) {
      const row = cells[r] || [];
      const toks = [];
      for (let c = 0; c < row.length; c++) toks.push(cellToken(row[c]));
      rowKeys.push(toks.join("_"));
    }
    return rowKeys.join("-");
  }

  // Card image format version — PREFIXES the cache key so that when the rendered
  // image changes (e.g. square -> 1.91:1 letterboxed card), old cached images are
  // orphaned instead of stuck (the store is first-write-wins). Bump on any image
  // format change.
  const KEY_VERSION = "c2";

  // positionKey(gameModule, state) -> string
  // Prefer the game's own canonical key (collapses transpositions properly);
  // otherwise fall back to the generic view-derived key. VISUAL position only,
  // prefixed with KEY_VERSION so the image cache invalidates on format changes.
  function positionKey(gameModule, state) {
    const raw =
      gameModule && typeof gameModule.positionKey === "function"
        ? gameModule.positionKey(state)
        : genericKey(gameModule, state);
    return KEY_VERSION + "-" + raw;
  }

  // ---- URLs ---------------------------------------------------------------

  function gameUrl(seed) {
    return SHARE_ORIGIN + "/g/" + seed;
  }

  function imageUrl(key) {
    return SHARE_ORIGIN + "/img/" + key + ".png";
  }

  // ---- share seed ---------------------------------------------------------

  // buildShareSeed(gameModule, state, players) -> string
  // Encode the game-page seed for `state` with transport meta:
  //   meta = { w, b, turn, san, key }
  //     w   : white player's handle   (players.w)
  //     b   : black player's handle   (players.b)
  //     turn: side to move, "w"/"b"   (gameModule.turn(state))
  //     san : last move's text        (players.san, pass-through — may be "")
  //     key : positionKey(state)      (the image cache-key)
  // Round-trips through Gage.decodeSeed: decode(seed).meta deep-equals this meta,
  // decode(seed).state deep-equals `state`.
  function buildShareSeed(gameModule, state, players) {
    players = players || {};
    const key = positionKey(gameModule, state);
    const turn = gameModule.turn(state);
    const san = players.san == null ? "" : String(players.san);
    const meta = { w: players.w, b: players.b, turn: turn, san: san, key: key };
    return Gage.encodeSeed(state, meta);
  }

  // ---- image upload (best-effort) ----------------------------------------

  // uploadBoardImage(gameModule, state) -> Promise<{ key, uploaded?, skipped?, error? }>
  // Ensure the board image for the current position exists at imageUrl(key):
  //   * HEAD it; a 200 means it's already cached -> resolve { key, skipped:true }.
  //   * otherwise render the PNG and PUT it (content-type: image/png)
  //       -> resolve { key, uploaded:true }.
  // The image is BEST-EFFORT: the move must post even if this fails. So any
  // network/render error resolves { key, error } instead of rejecting. Callers
  // fire-and-forget and ignore `error`.
  function uploadBoardImage(gameModule, state) {
    let key;
    try {
      key = positionKey(gameModule, state);
    } catch (e) {
      return Promise.resolve({ key: null, error: e });
    }
    const url = imageUrl(key);

    return fetch(url, { method: "HEAD" })
      .then(function (head) {
        if (head && head.ok) return { key: key, skipped: true };
        return boardImageBlobFor(gameModule, state).then(function (blob) {
          return fetch(url, {
            method: "PUT",
            headers: { "content-type": "image/png" },
            body: blob,
          }).then(function (put) {
            if (put && put.ok) return { key: key, uploaded: true };
            return { key: key, error: new Error("upload HTTP " + (put && put.status)) };
          });
        });
      })
      .catch(function (e) {
        return { key: key, error: e };
      });
  }

  // Small indirection so uploadBoardImage doesn't hard-depend on load order: if
  // board-image.js is present we use it; otherwise the promise rejects and the
  // caller's .catch turns it into { error } (image just won't upload).
  function boardImageBlobFor(gameModule, state) {
    if (typeof Gage.boardImageBlob === "function") {
      return Gage.boardImageBlob(gameModule, state);
    }
    return Promise.reject(new Error("[gage] Gage.boardImageBlob unavailable"));
  }

  Gage.SHARE_ORIGIN = SHARE_ORIGIN;
  Gage.positionKey = positionKey;
  Gage.gameUrl = gameUrl;
  Gage.imageUrl = imageUrl;
  Gage.buildShareSeed = buildShareSeed;
  Gage.uploadBoardImage = uploadBoardImage;
})();
