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

  // ---- panel visibility state -------------------------------------------
  // The panel shows ONLY on a Gage (#gage) game thread. There the player can
  // minimize it (collapse to the header) or close it (hide -> a small launcher
  // pill re-opens it). Collapsed/dismissed persist across re-renders on the SAME
  // thread and reset on navigation, so loading a new #gage tweet pops it up.
  let panelActive = false; // currently on a #gage game thread?
  let uiCollapsed = false; // minimized to header only
  let uiDismissed = false; // closed by the user (panel hidden, launcher shown)

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

  // Build the panel shell + the re-open launcher once. Returns false if the
  // panel already exists.
  function ensurePanel() {
    if (el("gage-panel")) return false;
    const panel = document.createElement("div");
    panel.id = "gage-panel";
    panel.innerHTML =
      '<div class="gage-head">' +
        '<span class="gage-title">♟ Gage <span class="gage-tag">dev</span></span>' +
        '<span class="gage-ctrls">' +
          '<button id="gage-min" class="gage-btn" type="button" title="Minimize" aria-label="Minimize">–</button>' +
          '<button id="gage-close" class="gage-btn" type="button" title="Close" aria-label="Close">×</button>' +
        '</span>' +
      '</div>' +
      '<div id="gage-body">' +
        '<div id="gage-mount"></div>' +
        '<div id="gage-status" class="gage-status">…</div>' +
      '</div>';
    document.body.appendChild(panel);
    el("gage-min").addEventListener("click", function () {
      uiCollapsed = !uiCollapsed;
      applyUiState();
    });
    el("gage-close").addEventListener("click", function () {
      uiDismissed = true;
      applyUiState();
    });

    // Small floating pill to re-open a closed panel (shown only while a game
    // thread is active and the panel has been dismissed).
    const launcher = document.createElement("button");
    launcher.id = "gage-launcher";
    launcher.type = "button";
    launcher.textContent = "♟";
    launcher.title = "Open Gage";
    launcher.addEventListener("click", function () {
      uiDismissed = false;
      uiCollapsed = false;
      applyUiState();
    });
    document.body.appendChild(launcher);
    return true;
  }

  // Reflect (panelActive, uiCollapsed, uiDismissed) onto the panel + launcher.
  function applyUiState() {
    const panel = el("gage-panel");
    const launcher = el("gage-launcher");
    if (!panel || !launcher) return;
    if (!panelActive) {
      // Not a game thread: nothing shows.
      panel.style.display = "none";
      launcher.style.display = "none";
      return;
    }
    if (uiDismissed) {
      panel.style.display = "none";
      launcher.style.display = "";
    } else {
      panel.style.display = "";
      launcher.style.display = "none";
      panel.classList.toggle("gage-collapsed", uiCollapsed);
    }
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

  // refresh(): read the live page, decide, and (re)render. Idempotent and safe to
  // call repeatedly — invoked on first mount, on X SPA navigation, on each new
  // reply (observer), and to restore authoritative state after a failed post. On
  // a #gage game thread it renders + observes and shows the panel (respecting
  // minimize/close); off a game thread it stops observing and HIDES the panel —
  // there is no always-on practice board.
  function refresh() {
    const ctx = readContext();
    const decision =
      Gage.orchestration && Gage.orchestration.decide
        ? Gage.orchestration.decide(ctx.rawTexts, { me: ctx.me, rootAuthor: ctx.rootAuthor })
        : { isGame: false };
    if (decision.isGame && Gage.games[decision.gameId]) {
      panelActive = true;
      setupGame(decision); // render + observe (into the panel, even while hidden)
      applyUiState();
    } else {
      panelActive = false;
      teardownObserver();
      applyUiState(); // hide the panel + launcher
    }
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
        // New thread: a fresh #gage game pops up (reset minimize/close).
        uiDismissed = false;
        uiCollapsed = false;
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
