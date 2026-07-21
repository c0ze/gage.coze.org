// Content script: mounts the board panel on X and wires local moves.
// The Twitter-DOM transport is stubbed behind an interface until the
// DM-vs-public-thread fork is decided — nothing else changes when it is.
(function () {
  const Gage = window.Gage || {};

  // ---- Transport interface (PENDING: DM vs public threaded reply) ----
  // Whichever we pick implements this shape; the rest of the extension is blind
  // to the choice.
  const Transport = {
    readIncoming() {
      // parse a move out of the current DM/tweet DOM -> game | null
      return null;
    },
    postMove(/* game */) {
      // drive the composer (DM compose or native reply), prefilled with the move
      console.warn("[gage] Transport.postMove not wired yet");
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
    const state = game.initialState();
    const status = panel.querySelector("#gage-status");
    Gage.renderGame(game, state, panel.querySelector("#gage-mount"), (mv) => {
      const label = mv.text || mv.from + "→" + mv.to;
      const term = game.terminal(mv.state);
      const suffix = term.over
        ? "  · " + (term.result === "draw" ? "draw" : term.result + " wins")
        : "";
      status.textContent = label + "  seed:" + mv.seed.slice(0, 24) + "…" + suffix;
      // Transport.postMove(...);  // <- wired once the fork is decided
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountPanel);
  } else {
    mountPanel();
  }
})();
