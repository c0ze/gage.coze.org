// Gage landing site — the "challenge creator" (flow A).
//
// This file owns ONLY the site's UI orchestration. Everything load-bearing —
// the real board, move legality, and the challenge text — comes from the shared
// core (window.Gage), the SAME modules the extension uses, copied into lib/ by
// build.sh. We do not reimplement any game logic here.
//
// Flow: pick game (chess) -> arena (X) -> type rival handle -> make ONE opening
// move on a real board -> "Throw down the gauntlet" opens X's web-intent
// composer, prefilled with the challenge post built by Gage.protocol.formatMove.
(function () {
  "use strict";

  // --- guard: the core must have loaded (classic scripts, window.Gage) --------
  var Gage = window.Gage;
  if (!Gage || !Gage.games || !Gage.games.chess || !Gage.renderGame || !Gage.protocol) {
    // If lib/ wasn't built (e.g. previewing without `sh site/build.sh`), fail
    // loudly in the board area rather than silently doing nothing.
    var mountFail = document.getElementById("board-mount");
    if (mountFail) {
      mountFail.innerHTML =
        '<p style="color:#c8253b;font-size:0.9rem;padding:16px;text-align:center;">' +
        "Gage core failed to load. Run <code>sh site/build.sh</code> to populate " +
        "<code>site/lib/</code>, then reload.</p>";
    }
    return;
  }

  // --- constants --------------------------------------------------------------
  var GAME_ID = "chess";
  var GITHUB_URL = "https://github.com/c0ze/gage.coze.org"; // repo for "Get it"
  var X_INTENT = "https://x.com/intent/tweet?text=";

  // --- DOM refs ---------------------------------------------------------------
  var frameEl = document.getElementById("board-frame");
  var mountEl = document.getElementById("board-mount");
  var captionEl = document.getElementById("board-caption");
  var rivalEl = document.getElementById("rival");
  var throwBtn = document.getElementById("throw-btn");
  var castNote = document.getElementById("cast-note");
  var previewBox = document.getElementById("preview");
  var previewText = document.getElementById("preview-text");
  var getItLink = document.getElementById("get-it");

  if (getItLink) getItLink.href = GITHUB_URL;

  // --- state ------------------------------------------------------------------
  // The chosen opening move in SAN (e.g. "e4"), or null until one is made.
  var openingSan = null;

  var chess = Gage.games[GAME_ID];

  // ---------------------------------------------------------------------------
  // Board: render fresh, capture the FIRST move only, then lock.
  // ---------------------------------------------------------------------------

  // Mount an interactive board at the start position. The renderer appends a new
  // grid each call, so we always clear the mount first to render "fresh".
  function mountInteractiveBoard() {
    mountEl.innerHTML = "";
    frameEl.classList.remove("is-locked");
    // Gage.renderGame(game, state, mountEl, onMove)
    Gage.renderGame(chess, chess.initialState(), mountEl, onFirstMove);
  }

  // onMove payload from the renderer: { from, to, text, seed, state }.
  // text is the SAN of the move just played (challenger is White, so this is
  // White's opening, e.g. "e4"). We take the FIRST move only.
  function onFirstMove(mv) {
    if (openingSan !== null) return; // already locked to an opening; ignore
    openingSan = mv.text; // SAN, e.g. "e4"
    lockBoardTo(mv.state);
    renderOpeningCaption();
    refreshCastState();
  }

  // Re-render the board read-only at the committed position: a fresh render onto
  // the mount with a no-op onMove, plus .is-locked (CSS disables pointer events
  // on the grid and stamps an "opening set" badge). We keep showing the position
  // rather than a blank board so the challenger sees exactly what they cast.
  function lockBoardTo(state) {
    mountEl.innerHTML = "";
    Gage.renderGame(chess, state, mountEl, function () {});
    frameEl.classList.add("is-locked");
  }

  // Caption: "Your opening: e4 — [change]" once a move is chosen; change resets
  // the board to the start position for a re-pick.
  function renderOpeningCaption() {
    captionEl.textContent = "Your opening: ";
    var strong = document.createElement("span");
    strong.className = "move";
    strong.textContent = openingSan;
    captionEl.appendChild(strong);

    var sep = document.createTextNode(" — ");
    captionEl.appendChild(sep);

    var change = document.createElement("button");
    change.type = "button";
    change.className = "link-btn";
    change.textContent = "change";
    change.addEventListener("click", resetOpening);
    captionEl.appendChild(change);
  }

  // Reset to the start position and let the player pick a different opening.
  function resetOpening() {
    openingSan = null;
    captionEl.textContent = "Move a white piece to choose your opening.";
    mountInteractiveBoard();
    refreshCastState();
  }

  // ---------------------------------------------------------------------------
  // Rival handle
  // ---------------------------------------------------------------------------
  // Accept the handle with or without a leading "@". We keep the raw text for the
  // input and only normalize when building the post (protocol.normalizeHandle
  // also tolerates a missing "@", so passing either form is safe).
  //
  // No autocomplete: X's user search requires the API we're deliberately not
  // using. (Bluesky offers a PUBLIC typeahead — app.bsky.actor
  // .searchActorsTypeahead — so a Bluesky arena could add suggestions later
  // without any auth.)
  function rivalRaw() {
    return (rivalEl.value || "").trim();
  }
  function hasRival() {
    // Require at least one non-"@" character so a lone "@" doesn't count.
    return rivalRaw().replace(/^@+/, "").length > 0;
  }

  // ---------------------------------------------------------------------------
  // Challenge text + intent URL
  // ---------------------------------------------------------------------------
  // Build the post with the SAME protocol the extension uses. formatMove yields
  // e.g.:  "♟ Chess challenge @rival — your move. #gage #chess [e4]"
  function buildChallengeText() {
    return Gage.protocol.formatMove({
      gameId: GAME_ID,
      moveText: openingSan,
      opponentHandle: rivalRaw(), // normalizeHandle adds "@" if missing
      isChallenge: true,
    });
  }

  // X web intent, text-only. Per spec we deliberately do NOT pass a url param —
  // the post is just the marker + move so the thread stays a clean move carrier.
  function buildIntentUrl(text) {
    return X_INTENT + encodeURIComponent(text);
  }

  function castChallenge() {
    if (!canCast()) return;
    var text = buildChallengeText();
    // Open X's composer in a new tab. noopener for safety.
    window.open(buildIntentUrl(text), "_blank", "noopener");
  }

  // ---------------------------------------------------------------------------
  // Cast button enable/disable + live preview
  // ---------------------------------------------------------------------------
  function canCast() {
    return hasRival() && openingSan !== null;
  }

  function refreshCastState() {
    var ready = canCast();
    throwBtn.disabled = !ready;

    if (ready) {
      castNote.classList.remove("warn");
      castNote.textContent = "Opens X with your challenge ready to post.";
      showPreview(buildChallengeText());
    } else {
      hidePreview();
      castNote.classList.remove("warn");
      if (!hasRival() && openingSan === null) {
        castNote.textContent = "Name a rival and choose an opening to cast your challenge.";
      } else if (!hasRival()) {
        castNote.textContent = "Name your rival to cast the challenge.";
      } else {
        castNote.textContent = "Make your opening move to cast the challenge.";
      }
    }
  }

  // Render the exact post text, lightly highlighting the #gage marker and the
  // [move] slot so the challenger sees what will be posted.
  function showPreview(text) {
    previewBox.hidden = false;
    previewText.textContent = ""; // clear

    // Tokenize into: marker (#gage), move slot ([...]), and plain runs. We build
    // via DOM nodes (no innerHTML with user text) to stay XSS-safe on the handle.
    var re = /(#gage\b|\[[^\]]*\])/g;
    var last = 0;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) {
        previewText.appendChild(document.createTextNode(text.slice(last, m.index)));
      }
      var span = document.createElement("span");
      span.className = m[0].charAt(0) === "#" ? "mk" : "mv";
      span.textContent = m[0];
      previewText.appendChild(span);
      last = re.lastIndex;
    }
    if (last < text.length) {
      previewText.appendChild(document.createTextNode(text.slice(last)));
    }
  }

  function hidePreview() {
    previewBox.hidden = true;
    previewText.textContent = "";
  }

  // ---------------------------------------------------------------------------
  // Wire up
  // ---------------------------------------------------------------------------
  rivalEl.addEventListener("input", refreshCastState);
  throwBtn.addEventListener("click", castChallenge);

  // Game / platform chips are single-option today (chess, X). They're already
  // marked active in the HTML; the disabled "coming soon" ones do nothing. We
  // still guard clicks so a future enabled chip is trivial to wire.
  document.querySelectorAll(".chip[data-game], .chip[data-platform]").forEach(function (chip) {
    chip.addEventListener("click", function () {
      if (chip.disabled) return;
      // (Only one selectable option per group for now — nothing to toggle.)
    });
  });

  // Initial paint.
  mountInteractiveBoard();
  refreshCastState();
})();
