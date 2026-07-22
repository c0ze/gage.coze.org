// Gage landing site — the "challenge creator".
//
// This file owns ONLY the site's UI orchestration. Everything load-bearing —
// the real board, move legality, and the challenge text — comes from the shared
// core (window.Gage), the SAME modules the extension uses, copied into lib/ by
// build.sh. We do NOT reimplement any game logic here.
//
// Flow: pick a game (chess / checkers / reversi / gomoku) -> pick a platform
// (X / Mastodon / Bluesky) -> make ONE opening move on a real board -> type the
// rival handle -> "Create challenge" opens that platform's web-intent composer,
// prefilled with the challenge post built by Gage.protocol.formatMove plus a
// gage.coze.org/g/<seed> share link.
(function () {
  "use strict";

  // --- guard: the core must have loaded (classic scripts, window.Gage) --------
  var Gage = window.Gage;
  if (
    !Gage || !Gage.games || !Gage.renderGame || !Gage.protocol ||
    !Gage.uploadBoardImage || !Gage.buildShareSeed || !Gage.gameUrl ||
    !Gage.games.chess || !Gage.games.checkers || !Gage.games.reversi || !Gage.games.gomoku
  ) {
    var mountFail = document.getElementById("board-mount");
    if (mountFail) {
      mountFail.innerHTML =
        '<p style="color:#b00020;font-size:0.9rem;padding:16px;text-align:center;">' +
        "Gage core failed to load. Run <code>sh site/build.sh</code> to populate " +
        "<code>site/lib/</code>, then reload.</p>";
    }
    return;
  }

  // --- constants --------------------------------------------------------------
  var GITHUB_URL = "https://github.com/c0ze/gage.coze.org";

  // Per-platform compose-intent URL prefixes. The challenge text is appended
  // URL-encoded. (Mastodon has no universal intent, so we open mastodon.social.)
  var PLATFORM_INTENT = {
    x: "https://x.com/intent/tweet?text=",
    mastodon: "https://mastodon.social/share?text=",
    bluesky: "https://bsky.app/intent/compose?text=",
  };

  // --- DOM refs ---------------------------------------------------------------
  var frameEl = document.getElementById("board-frame");
  var mountEl = document.getElementById("board-mount");
  var captionEl = document.getElementById("board-caption");
  var rivalEl = document.getElementById("rival");
  var throwBtn = document.getElementById("throw-btn");
  var castNote = document.getElementById("cast-note");
  var platformNote = document.getElementById("platform-note");
  var previewBox = document.getElementById("preview");
  var previewText = document.getElementById("preview-text");
  var getItLink = document.getElementById("get-it");
  var gameChipsEl = document.getElementById("game-chips");
  var platformChipsEl = document.getElementById("platform-chips");

  if (getItLink) getItLink.href = GITHUB_URL;

  // --- state ------------------------------------------------------------------
  var gameId = "chess";       // selected game id
  var platform = "x";         // selected platform id
  var game = Gage.games[gameId];

  // The chosen opening move's text (chess SAN "e4", checkers "b6-a5", reversi/
  // gomoku square token "d3"), or null until one is made.
  var openingText = null;
  // The State immediately AFTER the chosen opening — the exact position we encode
  // into the share seed (and upload an image for) on Create. null until a move is
  // chosen (reset to null when the game changes or the opening is changed).
  var openingState = null;

  // ---------------------------------------------------------------------------
  // Board: render fresh for the current game, capture the FIRST move, then lock.
  // ---------------------------------------------------------------------------

  // Mount an interactive board at the start position of the current game. The
  // renderer appends a new grid each call, so we always clear the mount first.
  function mountInteractiveBoard() {
    mountEl.innerHTML = "";
    frameEl.classList.remove("is-locked");
    // Gage.renderGame(game, state, mountEl, onMove) — works for movement AND
    // placement games (reversi/gomoku commit on a single click).
    Gage.renderGame(game, game.initialState(), mountEl, onFirstMove);
  }

  // onMove payload from the renderer: { from, to, text, seed, state }. `text` is
  // the move just played by the side to move (challenger is White / first, so
  // this is the opening). We take the FIRST move only.
  function onFirstMove(mv) {
    if (openingText !== null) return; // already locked to an opening; ignore
    openingText = mv.text;   // game's move text (SAN / notation / square token)
    openingState = mv.state; // the post-opening position
    lockBoardTo(mv.state);
    renderOpeningCaption();
    refreshCastState();

    // Best-effort: warm the board-image cache now, while the user types the
    // rival handle. uploadBoardImage never throws — it resolves { error } — but
    // we still guard with .catch so a rejection can't surface as an unhandled
    // rejection or break this handler.
    try {
      Gage.uploadBoardImage(game, mv.state)
        .then(function (res) {
          if (res && res.error) {
            console.warn("[gage] board image upload failed (non-fatal):", res.error);
          }
        })
        .catch(function () { /* best-effort: ignore */ });
    } catch (e) {
      /* uploadBoardImage shouldn't throw synchronously; ignore if it does */
    }
  }

  // Re-render the board read-only at the committed position: a fresh render with
  // a no-op onMove, plus .is-locked (CSS disables pointer events + stamps a
  // badge). We keep showing the position so the challenger sees what they cast.
  function lockBoardTo(state) {
    mountEl.innerHTML = "";
    Gage.renderGame(game, state, mountEl, function () {});
    frameEl.classList.add("is-locked");
  }

  // Caption: "Your opening: <move> — [change]" once a move is chosen; change
  // resets the board to the start position for a re-pick.
  function renderOpeningCaption() {
    captionEl.textContent = "Your opening: ";
    var strong = document.createElement("span");
    strong.className = "move";
    strong.textContent = openingText;
    captionEl.appendChild(strong);

    captionEl.appendChild(document.createTextNode(" — "));

    var change = document.createElement("button");
    change.type = "button";
    change.className = "link-btn";
    change.textContent = "change";
    change.addEventListener("click", resetOpening);
    captionEl.appendChild(change);
  }

  // Reset to the start position so the player can pick a different opening.
  function resetOpening() {
    openingText = null;
    openingState = null;
    captionEl.textContent = defaultCaption();
    mountInteractiveBoard();
    refreshCastState();
  }

  function defaultCaption() {
    return "You play first — make a move to set the opening.";
  }

  // ---------------------------------------------------------------------------
  // Game / platform pickers
  // ---------------------------------------------------------------------------
  // Switching game clears the current opening and re-renders that game's board.
  function selectGame(id) {
    if (id === gameId || !Gage.games[id]) return;
    gameId = id;
    game = Gage.games[id];
    openingText = null;
    openingState = null;
    setActiveChip(gameChipsEl, "game", id);
    captionEl.textContent = defaultCaption();
    mountInteractiveBoard();
    refreshCastState();
  }

  function selectPlatform(id) {
    if (!PLATFORM_INTENT[id]) return;
    platform = id;
    setActiveChip(platformChipsEl, "platform", id);
    if (platformNote) platformNote.hidden = id !== "mastodon";
    refreshCastState();
  }

  // Mark the chip whose data-<attr> === value active (aria-pressed + class),
  // clearing the rest in the group.
  function setActiveChip(groupEl, attr, value) {
    var chips = groupEl.querySelectorAll(".chip");
    for (var i = 0; i < chips.length; i++) {
      var active = chips[i].getAttribute("data-" + attr) === value;
      chips[i].classList.toggle("is-active", active);
      chips[i].setAttribute("aria-pressed", active ? "true" : "false");
    }
  }

  // ---------------------------------------------------------------------------
  // Rival handle
  // ---------------------------------------------------------------------------
  // Accept the handle with or without a leading "@". normalizeHandle (in the
  // protocol) tolerates a missing "@", so passing either form is safe.
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
  // We then append a share link to the game page:
  //   "<challenge> https://gage.coze.org/g/<seed>"
  // The seed encodes the post-opening position + players so the Worker at that
  // URL can serve a board-image card. The link is ADDITIVE — after the
  // "[move] #gage" grammar — so parseMove still reads the move from the "[...]"
  // slot unchanged. Challenger handle `w` is unknown here, so it's "".
  function buildChallengeText() {
    var challenge = Gage.protocol.formatMove({
      gameId: gameId,
      moveText: openingText,
      opponentHandle: rivalRaw(), // normalizeHandle adds "@" if missing
      isChallenge: true,
    });
    var seed = Gage.buildShareSeed(game, openingState, {
      w: "",             // challenger handle unknown on the site
      b: rivalRaw(),     // the rival we're challenging
      san: openingText,  // the opening's move text
    });
    return challenge + " " + Gage.gameUrl(seed);
  }

  // Compose-intent URL for the selected platform, text-only.
  function buildIntentUrl(text) {
    return PLATFORM_INTENT[platform] + encodeURIComponent(text);
  }

  function castChallenge() {
    if (!canCast()) return;
    var text = buildChallengeText();
    // Open the platform's composer in a new tab. noopener for safety.
    window.open(buildIntentUrl(text), "_blank", "noopener");
  }

  // ---------------------------------------------------------------------------
  // Cast button enable/disable + live preview
  // ---------------------------------------------------------------------------
  function canCast() {
    return hasRival() && openingText !== null;
  }

  function platformLabel() {
    return platform === "x" ? "X" : platform === "mastodon" ? "Mastodon" : "Bluesky";
  }

  function refreshCastState() {
    var ready = canCast();
    throwBtn.disabled = !ready;

    if (ready) {
      castNote.textContent = "Opens " + platformLabel() + " with your challenge ready to post.";
      showPreview(buildChallengeText());
    } else {
      hidePreview();
      if (!hasRival() && openingText === null) {
        castNote.textContent = "Make a move and name a rival to create your challenge.";
      } else if (openingText === null) {
        castNote.textContent = "Make your opening move to create the challenge.";
      } else {
        castNote.textContent = "Name your rival to create the challenge.";
      }
    }
  }

  // Render the exact post text, lightly highlighting the #gage marker and the
  // [move] slot. We build via DOM nodes (no innerHTML with user text) to stay
  // XSS-safe on the handle.
  function showPreview(text) {
    previewBox.hidden = false;
    previewText.textContent = "";

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

  gameChipsEl.addEventListener("click", function (e) {
    var chip = e.target.closest(".chip[data-game]");
    if (chip) selectGame(chip.getAttribute("data-game"));
  });
  platformChipsEl.addEventListener("click", function (e) {
    var chip = e.target.closest(".chip[data-platform]");
    if (chip) selectPlatform(chip.getAttribute("data-platform"));
  });

  // Initial paint.
  captionEl.textContent = defaultCaption();
  mountInteractiveBoard();
  refreshCastState();
})();
