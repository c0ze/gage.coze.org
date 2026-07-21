// Content script: the game-play ORCHESTRATION (the "glue"). Mounts the board
// panel on X and runs the Gage game loop over PUBLIC THREADED REPLIES.
//
// Two modes, chosen per page on mount (all the hard decisions live in the PURE,
// unit-tested Gage.orchestration.decide — this file is just DOM plumbing):
//
//   GAME MODE   — the current page is a Gage game thread (its root tweet is a
//     #gage challenge declaring a known game). We reconstruct the position from
//     the reply chain, render it, and — only when it's the logged-in user's
//     legal turn — let them make a move that fills a reply (they press "Reply"
//     to actually post; AUTO_SEND stays off). An observer re-hydrates the board
//     when the opponent replies, flipping interactivity back to us on our turn.
//
//   PRACTICE MODE — any non-Gage page: a local board vs self (unchanged legacy
//     behavior), so the panel is always useful even off a game thread.
(function () {
  const Gage = window.Gage || {};

  // ---- small DOM helpers ------------------------------------------------
  function el(id) {
    return document.getElementById(id);
  }
  function setStatus(text) {
    const s = el("gage-status");
    if (s) s.textContent = text;
  }
  function clearMount() {
    const m = el("gage-mount");
    if (m) m.innerHTML = "";
    return m;
  }

  // Build the panel shell once. Returns false if it already exists.
  function ensurePanel() {
    if (el("gage-panel")) return false;
    const panel = document.createElement("div");
    panel.id = "gage-panel";
    panel.innerHTML =
      '<div class="gage-head">♟ Gage <span class="gage-tag">dev</span></div>' +
      '<div id="gage-mount"></div>' +
      '<div id="gage-status" class="gage-status">…</div>';
    document.body.appendChild(panel);
    return true;
  }

  // Read the live identity + thread once. Isolated so orchestration stays pure:
  // decide() takes plain data, this is the only place that touches the DOM layer.
  function readContext() {
    const tt = Gage.threadTransport;
    return {
      rawTexts: tt && tt.readThreadMoves ? tt.readThreadMoves() : [],
      me: tt && tt.getMyHandle ? tt.getMyHandle() : null,
      rootAuthor: tt && tt.getRootAuthorHandle ? tt.getRootAuthorHandle() : null,
    };
  }

  // ---- GAME MODE --------------------------------------------------------
  // A single live observer + a single render. setupGame() is idempotent and
  // re-runnable: every call disconnects the previous observer, re-reads the
  // thread, re-decides, and re-renders — so an opponent's reply just re-invokes
  // it. We keep the disconnect handle on the panel so re-entry can't leak
  // observers.
  let disconnectObserver = null;

  function teardownObserver() {
    if (typeof disconnectObserver === "function") {
      try { disconnectObserver(); } catch (e) { /* ignore */ }
    }
    disconnectObserver = null;
  }

  function setupGame(decision) {
    const game = Gage.games[decision.gameId];
    const mount = clearMount();
    if (!mount) return;

    setStatus(decision.status);

    // Interactivity gate. board.js has no read-only flag and mutates its own
    // `current` on click, so we gate at the mount: when it's NOT our legal turn
    // (spectator / waiting / over / desync) we (a) pass an inert onMove and
    // (b) block pointer events on the board so a stray local click can't advance
    // a position we don't own. Only a clean, my-turn frame is clickable.
    mount.style.pointerEvents = decision.interactive ? "auto" : "none";

    if (decision.interactive) {
      Gage.renderGame(game, decision.state, mount, function (mv) {
        // A legal LOCAL move happened. Publish it as a reply carrying the SAN
        // token; the player presses "Reply" to send (AUTO_SEND off). We do NOT
        // optimistically flip the board — the observer re-hydrates from the
        // thread once the reply lands, keeping the DOM the single source of truth.

        // Best-effort: upload the board image for the position AFTER this move so
        // the reply's share link renders an image card. Fire-and-forget —
        // uploadBoardImage never throws (resolves { error }); the extra .catch is
        // belt-and-suspenders so nothing here can block or break posting the move.
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

        // Reply text = the move token grammar + a share link to the game page.
        // The link is ADDITIVE (after "[move] #gage"), so parseMove still reads
        // the move from the "[...]" slot on the other client. white/black come
        // from the decision (decide() sets decision.white/decision.black), san is
        // the move just played.
        const text =
          Gage.protocol.formatMove({
            gameId: decision.gameId,
            moveText: mv.text,
            isChallenge: false,
          }) +
          " " +
          Gage.gameUrl(
            Gage.buildShareSeed(game, mv.state, {
              w: decision.white,
              b: decision.black,
              san: mv.text,
            })
          );
        // Freeze further local input until the thread confirms our move.
        mount.style.pointerEvents = "none";
        setStatus("your move " + mv.text + " posted — press Reply to send");
        Promise.resolve()
          .then(function () { return Gage.threadTransport.postReply(text); })
          .catch(function (e) {
            setStatus("couldn't open the reply — " + (e && e.message ? e.message : e) + " · restoring");
            refresh(); // restore the authoritative board + re-enable so the player can retry
          });
      });
    } else {
      // Read-only: render the authoritative position; onMove is inert (and the
      // mount ignores pointer events anyway).
      Gage.renderGame(game, decision.state, mount, function () {});
    }

    // Re-hydrate on any new reply: re-read the thread, re-decide, re-render. A
    // single observer; re-subscribing tears the old one down first.
    teardownObserver();
    if (Gage.threadTransport && Gage.threadTransport.observe) {
      disconnectObserver = Gage.threadTransport.observe(function () {
        refresh();
      });
    }
  }

  // refresh(): read the live page, decide the mode, and (re)render. Idempotent
  // and safe to call repeatedly — invoked on first mount, on X SPA navigation, on
  // each new reply (observer), and to restore authoritative state after a failed
  // post. setupGame/setupPractice each tear down the prior observer, so re-entry
  // can't leak and a non-game result cleanly REPLACES a stale board (rather than
  // leaving it clickable).
  function refresh() {
    const ctx = readContext();
    const decision =
      Gage.orchestration && Gage.orchestration.decide
        ? Gage.orchestration.decide(ctx.rawTexts, { me: ctx.me, rootAuthor: ctx.rootAuthor })
        : { isGame: false };
    if (decision.isGame && Gage.games[decision.gameId]) {
      setupGame(decision);
    } else {
      setupPractice();
    }
  }

  // ---- PRACTICE MODE (legacy local board vs self) -----------------------
  function setupPractice() {
    teardownObserver();
    const game = Gage.games.chess;
    const mount = clearMount();
    if (!mount) return;
    mount.style.pointerEvents = "auto";
    setStatus("practice — click a piece, then a square (no game thread here)");

    Gage.renderGame(game, game.initialState(), mount, function (mv) {
      const label = mv.text || mv.from + "→" + mv.to;
      const term = game.terminal(mv.state);
      const suffix = term.over
        ? "  · " + (term.result === "draw" ? "draw" : term.result + " wins")
        : "";
      setStatus(label + "  seed:" + mv.seed.slice(0, 24) + "…" + suffix);
    });
  }

  // ---- entry ------------------------------------------------------------
  function mountPanel() {
    ensurePanel();
    refresh();
    // X is a single-page app: it navigates by URL change WITHOUT a reload, and it
    // updates location.href BEFORE the new thread's DOM is in place. So on a URL
    // change we don't refresh once (that would bind to the old / soon-detached
    // container) — we run a short "settle" loop that re-reads and rebinds a few
    // times until the new thread hydrates. refresh() is idempotent and tears down
    // the prior observer, so the extra runs are harmless; the last one that sees
    // the hydrated thread is the one that sticks.
    let lastHref = location.href;
    let settleTimer = null;
    function settle() {
      if (settleTimer) clearInterval(settleTimer);
      let n = 0;
      refresh();
      settleTimer = setInterval(function () {
        refresh();
        if (++n >= 6) { clearInterval(settleTimer); settleTimer = null; } // ~2.4s window
      }, 400);
    }
    setInterval(function () {
      if (location.href !== lastHref) {
        lastHref = location.href;
        settle();
      }
    }, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountPanel);
  } else {
    mountPanel();
  }
})();
