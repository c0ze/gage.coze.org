// Content script: mounts the board panel on X and wires local moves.
// TRANSPORT = public threaded replies (decided). The pure protocol/reconstruct
// layers are done; the DOM-coupled thread layer (Gage.threadTransport) is still
// stubbed for the live-X selectors — see src/transport/thread-dom.js. This file
// binds those modules to the panel without depending on the stub being live, so
// the local practice board keeps working today.
(function () {
  const Gage = window.Gage || {};

  // ---- Transport facade -------------------------------------------------
  // Thin adapter over the transport modules so mountPanel() stays oblivious to
  // their internals. protocol/reconstruct are PURE and usable now; the DOM
  // methods delegate to the (currently stubbed) threadTransport.
  const Transport = {
    // Build the tweet text for a move (challenge = root, else reply).
    format(opts) {
      return Gage.protocol ? Gage.protocol.formatMove(opts) : null;
    },
    // Rebuild State from the reply chain currently in the DOM. Returns the
    // reconstruct result ({ state, moveCount, error }) or null if unavailable.
    // Today threadTransport.readThreadMoves() is a stub ([]), so this yields the
    // initial state; it becomes live once the thread-dom selectors are wired.
    readThread(gameModule) {
      if (!Gage.threadTransport || !Gage.reconstruct || !Gage.protocol) return null;
      // readThreadMoves() yields RAW tweet texts; parse each into a move token,
      // drop chatter / non-Gage tweets, then reconstruct the game from the chain.
      const moveTexts = Gage.threadTransport
        .readThreadMoves()
        .map((t) => Gage.protocol.parseMove(t))
        .filter(Boolean)
        .map((p) => p.moveText);
      return Gage.reconstruct(gameModule, moveTexts);
    },
    // Post a move into the thread (drives X's composer). Stubbed until wired.
    postMove(text) {
      if (Gage.threadTransport) Gage.threadTransport.postReply(text);
      else console.warn("[gage] threadTransport missing; move not posted");
    },
    // Subscribe to incoming replies. Stubbed until wired.
    observe(onNewMove) {
      if (Gage.threadTransport) Gage.threadTransport.observe(onNewMove);
    },
  };

  function mountPanel() {
    if (document.getElementById("gage-panel")) return;
    const panel = document.createElement("div");
    panel.id = "gage-panel";
    panel.innerHTML =
      '<div class="gage-head">♟ Gage <span class="gage-tag">dev</span></div>' +
      '<div id="gage-mount"></div>' +
      '<div id="gage-status" class="gage-status">start position — click a piece, then a square</div>';
    document.body.appendChild(panel);

    // Chess is the first Game module; the renderer is game-agnostic, so
    // swapping in checkers/reversi later is just a different module here.
    const game = Gage.games.chess;
    const status = panel.querySelector("#gage-status");

    // Hydrate from the reply chain if one exists. Inert today (the DOM layer is
    // stubbed -> empty thread -> initial state) but the single place that goes
    // live once thread-dom selectors are wired: render the RECONSTRUCTED position
    // (not always the start), and surface a desync if a thread move won't replay.
    const rebuilt = Transport.readThread(game);
    const state = rebuilt && rebuilt.state ? rebuilt.state : game.initialState();
    if (rebuilt && rebuilt.error && rebuilt.error.index >= 0) {
      status.textContent =
        "thread desync at move " + (rebuilt.error.index + 1) +
        " (" + rebuilt.error.moveText + ")";
    }

    Gage.renderGame(game, state, panel.querySelector("#gage-mount"), (mv) => {
      const label = mv.text || mv.from + "→" + mv.to;
      const term = game.terminal(mv.state);
      const suffix = term.over
        ? "  · " + (term.result === "draw" ? "draw" : term.result + " wins")
        : "";
      status.textContent = label + "  seed:" + mv.seed.slice(0, 24) + "…" + suffix;

      // ---- LIVE THREAD TRANSPORT HOOK -----------------------------------
      // Once src/transport/thread-dom.js selectors are filled, uncomment to
      // publish each local move as a reply (and the very first move of a new
      // game as a challenge root). `mv.text` is the SAN slot payload.
      //
      //   const isChallenge = mv.state.moves.length === 1;
      //   Transport.postMove(
      //     Transport.format({
      //       gameId: game.id,
      //       moveText: mv.text,
      //       opponentHandle: /* rival's @handle */ null,
      //       isChallenge,
      //     })
      //   );
      // -------------------------------------------------------------------
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountPanel);
  } else {
    mountPanel();
  }
})();
