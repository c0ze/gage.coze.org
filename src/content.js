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
  // Signature of the last-rendered decision. refresh() re-renders ONLY when this
  // changes, so a spurious observer fire — Mastodon mutates its DOM constantly, and
  // opening the reply composer mutates it too — can't rebuild the board and clobber
  // an in-progress two-click selection or a just-made local move the thread hasn't
  // caught up to yet. Reset on navigation.
  let lastRenderSig = null;

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
    // Brand mark: a minimal rounded square holding a knight glyph, in --accent.
    // Kept clean and modern (not a crest); inline SVG so it's self-contained.
    var GAGE_MARK =
      '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="currentColor" opacity="0.14"/>' +
        '<rect x="1.5" y="1.5" width="21" height="21" rx="6" stroke="currentColor" stroke-width="1.5"/>' +
        '<path d="M9 17h7c0-3.2-.7-5.1-2.1-6.6.4-.5.6-1 .6-1.7 0-.5-.2-1-.5-1.4l-1 1-.7-.9c-1.9.2-3.4 1.3-4.2 3l1.7.7-1.9 1.6c.2 1.7 .6 3.1 1.2 4.3z" fill="currentColor"/>' +
      '</svg>';
    panel.innerHTML =
      '<div class="gage-head">' +
        '<span class="gage-title">' + GAGE_MARK + 'Gage</span>' +
        '<span class="gage-ctrls">' +
          '<button id="gage-refresh" class="gage-btn" type="button" title="Refresh from the thread" aria-label="Refresh">↻</button>' +
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
    el("gage-refresh").addEventListener("click", function () {
      // Force a fresh read of the thread + re-render — e.g. after the opponent
      // replies and the observer hasn't caught it, or to reset an in-progress move.
      refresh(true);
    });

    // Small floating pill to re-open a closed panel (shown only while a game
    // thread is active and the panel has been dismissed).
    const launcher = document.createElement("button");
    launcher.id = "gage-launcher";
    launcher.type = "button";
    launcher.innerHTML = GAGE_MARK;
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
      // Prefer readThreadPosts ({text, author} pairs) so decide() can gate each
      // move by its author; fall back to the legacy text-only read (decide()
      // accepts both shapes — string items are treated as author-unknown).
      rawPosts:
        tt && tt.readThreadPosts
          ? tt.readThreadPosts()
          : tt && tt.readThreadMoves
            ? tt.readThreadMoves()
            : [],
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

  // Reply text = the move token grammar, plus a /g/<seed> share link on X and
  // Mastodon. On Bluesky the link is OMITTED: bsky counts the RAW URL toward its
  // 300-grapheme limit (X/Mastodon count links as a flat ~23), and the seed
  // encodes the whole move list, so link-bearing replies stop fitting around
  // move 6-8 and Publish silently disables. The link is cosmetic there anyway —
  // board-inject.js already renders the board inline under each move reply for
  // extension users on Bluesky, and thread reconstruction only needs the
  // "[move] #gage" token. stateAfter is the position AFTER the move (the seed
  // must encode it so its meta.turn matches the reconstructed thread).
  function buildMoveReplyText(game, decision, moveText, stateAfter) {
    const text = Gage.protocol.formatMove({
      gameId: decision.gameId,
      moveText: moveText,
      isChallenge: false,
    });
    if (Gage.platform === "bluesky") return text;
    return (
      text +
      " " +
      Gage.gameUrl(
        Gage.buildShareSeed(game, stateAfter, {
          w: decision.white,
          b: decision.black,
          san: moveText,
        })
      )
    );
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

    // PASS control (reversi only): when it's our interactive turn but the side to
    // move has NO legal placement while the game is not over, the rules force a
    // pass. mustPass is optional (undefined on chess/checkers/gomoku), so guard.
    // Clicking posts a pass through the SAME reply path a normal move uses, with
    // the literal move text "pass".
    if (
      decision.interactive &&
      typeof game.mustPass === "function" &&
      game.mustPass(decision.state)
    ) {
      const passBtn = document.createElement("button");
      passBtn.id = "gage-pass";
      passBtn.type = "button";
      passBtn.className = "gage-pass";
      passBtn.textContent = "Pass";
      passBtn.title = "You have no legal move — pass the turn";
      passBtn.addEventListener("click", function () {
        // Same reply grammar as onMove, but the move token is the literal "pass".
        // The share link (where present — see buildMoveReplyText) must encode the
        // state AFTER the pass (turn flipped, board unchanged) so its meta.turn
        // matches the reconstructed thread — mirror the normal onMove path, which
        // seeds mv.state (the post-move state). Fall back to the pre-pass state if
        // applyMoveText is somehow unavailable.
        const afterPass =
          (typeof game.applyMoveText === "function" &&
            game.applyMoveText(decision.state, "pass")) ||
          decision.state;
        const text = buildMoveReplyText(game, decision, "pass", afterPass);
        passBtn.disabled = true;
        mount.style.pointerEvents = "none";
        setStatus("pass posted — press Reply to send");
        Promise.resolve()
          .then(function () { return Gage.threadTransport.postReply(text); })
          .catch(function (e) {
            refresh(true); // force a re-render to restore the board (the sig is unchanged)
            // AFTER refresh — setupGame sets the normal status, which would bury the
            // error; overriding here keeps the failure visible until the next change.
            setStatus("couldn't open the reply — " + (e && e.message ? e.message : e));
          });
      });
      mount.appendChild(passBtn);
    }

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

        // Reply text = the move token grammar + (on X/Mastodon) a share link to
        // the game page. The link is ADDITIVE (after "[move] #gage"), so parseMove
        // still reads the move from the "[...]" slot on the other client; on
        // Bluesky it's dropped entirely — see buildMoveReplyText for why.
        const text = buildMoveReplyText(game, decision, mv.text, mv.state);
        // Freeze further local input until the thread confirms our move.
        mount.style.pointerEvents = "none";
        setStatus("your move " + mv.text + " posted — press Reply to send");
        Promise.resolve()
          .then(function () { return Gage.threadTransport.postReply(text); })
          .catch(function (e) {
            refresh(true); // force-restore the authoritative board + re-enable (sig unchanged)
            // AFTER refresh — setupGame sets the normal status, which would bury the
            // error; overriding here keeps the failure visible until the next change.
            setStatus("couldn't open the reply — " + (e && e.message ? e.message : e));
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
  // A compact signature of everything a rendered frame depends on. Two consecutive
  // decisions that share a signature mean the thread hasn't advanced — there is
  // nothing new to draw, and re-rendering would only destroy the live board (and any
  // in-progress selection / un-posted local move).
  function decisionSig(d) {
    // Include the reconstructed position (state) so an EDITED/replaced move with the
    // same count still registers as a change; the rest captures the panel's frame.
    return [d.gameId, d.moveCount, d.state ? JSON.stringify(d.state) : "",
      d.interactive, d.over, d.error ? "e" : "-", d.turn, d.white, d.black,
      d.myColor, d.status].join("|");
  }

  // ---- late-author correction -------------------------------------------
  // The decision layer TRUSTS a move-shaped post whose author is null (adapters
  // return null while the author block hasn't hydrated — and legacy input has no
  // authors at all). A post can hydrate its TEXT before its AUTHOR, so a read in
  // that window may accept a move the fully-hydrated read would skip (e.g. an
  // outsider's "[e5] #gage") — and nothing on the page is guaranteed to mutate
  // again to trigger the corrective re-read. So: whenever a game-mode read
  // contains a move-shaped post with a null author, schedule a bounded series of
  // delayed refreshes until the thread reads fully attributed (or we give up —
  // a page whose author markup NEVER resolves is the legacy trust-all mode by
  // design, not an error). Counter resets on navigation.
  let authorRetryTimer = null;
  let authorRetries = 0;
  const AUTHOR_RETRY_MS = 700;
  const AUTHOR_RETRY_MAX = 6; // ~4s of grace — hydration is fast when it happens
  function hasUnattributedMove(rawPosts) {
    const protocol = Gage.protocol;
    if (!protocol || !protocol.parseMove || !Array.isArray(rawPosts)) return false;
    return rawPosts.some(function (p) {
      return (
        p != null && typeof p === "object" && p.author == null &&
        typeof p.text === "string" && !!protocol.parseMove(p.text)
      );
    });
  }
  function scheduleAuthorRetry() {
    if (authorRetryTimer || authorRetries >= AUTHOR_RETRY_MAX) return;
    authorRetries++;
    authorRetryTimer = setTimeout(function () {
      authorRetryTimer = null;
      refresh(); // unforced: only re-renders if the re-read actually changed things
    }, AUTHOR_RETRY_MS);
  }

  // force=true always (re)renders — used by the settle loop (initial mount + nav,
  // which must re-establish the board + re-attach the observer to the CURRENT
  // container) and by postReply failure-recovery (restore). force=false is the
  // OBSERVER's path: (re)render only when the reconstructed game changed, so a
  // spurious observer fire can't clobber an in-progress selection / un-posted move.
  function refresh(force) {
    const ctx = readContext();
    const decision =
      Gage.orchestration && Gage.orchestration.decide
        ? Gage.orchestration.decide(ctx.rawPosts, { me: ctx.me, rootAuthor: ctx.rootAuthor })
        : { isGame: false };
    if (decision.isGame && Gage.games[decision.gameId]) {
      panelActive = true;
      // A move-shaped post read before its author hydrated? Re-read shortly —
      // the fully-attributed read may skip it (authorship gate). Bounded; see
      // the late-author correction block above.
      if (hasUnattributedMove(ctx.rawPosts)) scheduleAuthorRetry();
      else authorRetries = 0; // fully attributed — reset the grace budget
      // Re-render ONLY when the reconstructed game changed (or the board isn't
      // mounted yet). This turns a spurious observer fire into a no-op instead of a
      // board-wiping rebuild — the key to two-click games (checkers) and un-posted
      // local moves surviving on mutation-heavy platforms like Mastodon. A genuine
      // new reply changes moveCount/turn/status, so real updates still re-render.
      const sig = decisionSig(decision);
      const mount = el("gage-mount");
      if (force || sig !== lastRenderSig || !mount || !mount.firstChild) {
        lastRenderSig = sig;
        setupGame(decision); // render + (re)observe (into the panel, even while hidden)
      }
      applyUiState();
      // Drop a board image under each move reply (Bluesky only; deduped by position
      // so this is a cheap no-op when nothing changed, and re-injects if the platform
      // recycled a post's node). Runs OUTSIDE the sig-gate so recycled boards return.
      if (Gage.injectThreadBoards) Gage.injectThreadBoards(Gage.games[decision.gameId]);
    } else {
      panelActive = false;
      lastRenderSig = null;
      teardownObserver();
      // Left a game thread (SPA nav): drop any boards injected into the old thread so
      // a recycled node can't keep a stale one — the in-game sweep no longer runs here.
      if (Gage.clearThreadBoards) Gage.clearThreadBoards();
      applyUiState(); // hide the panel + launcher
    }
  }

  // ---- entry ------------------------------------------------------------
  function mountPanel() {
    ensurePanel();
    // X is a single-page app: it navigates by URL change WITHOUT a reload, and it
    // updates location.href BEFORE the new thread's DOM is in place. It ALSO
    // hydrates a directly-opened permalink / hard reload asynchronously — the
    // focal tweet lands a beat AFTER our content script first runs. So we must
    // never refresh just once: a single read races hydration and, on a real game
    // thread not in the DOM yet, wrongly decides "not a game" and hides the panel
    // with no retry — the bug where opening a #gage tweet link directly did
    // nothing. Instead we "settle": re-read and rebind until the thread is
    // recognized (or we give up). refresh() is idempotent and tears down the prior
    // observer, so the extra runs are harmless; the run that sees the hydrated
    // thread is the one that sticks, after which the observer drives updates.
    let settleTimer = null;
    // settle(canEarlyStop): re-read + rebind on a short interval until the thread
    // has settled. Two callers with different needs:
    //   • initial mount (canEarlyStop = true): there is NO prior thread, so the
    //     moment refresh() recognizes a game (panelActive) we can stop — the
    //     observer drives it from there. The long cap just covers a slow cold load.
    //   • URL change (canEarlyStop = false): X flips location.href BEFORE swapping
    //     the DOM, so the OLD thread is briefly still present and panelActive is
    //     stale-true for the outgoing game. Early-stopping there would lock onto it
    //     and miss the incoming game, so on nav we DON'T early-stop — we ride a
    //     fixed bounded window until the new DOM has replaced the old, ending on
    //     the settled thread. refresh() re-decides from the live DOM each call and
    //     tears down the prior observer, so the interim re-reads are safe.
    // Late-hydration tail: the fixed settle window above covers the normal
    // hydration race, but a slow thread (cold cache, big thread, slow Mastodon
    // instance) can hydrate AFTER it — the page would be decided "not a game"
    // and nothing would ever re-check until the next URL change. So when a
    // settle window ends UNRECOGNIZED, keep polling at a gentler 1s cadence for
    // ~12s more (≈15s total from a nav), stopping the moment a game is
    // recognized — from there the observer drives updates as usual. Shares
    // settleTimer with settle() so a new nav (or re-settle) always replaces the
    // tail instead of stacking a second loop. On a genuinely non-game page this
    // is a handful of cheap no-op re-reads and then silence.
    function settleLate() {
      let n = 0;
      const maxTicks = 12; // ~12s at 1s ticks
      settleTimer = setInterval(function () {
        if (panelActive) { clearInterval(settleTimer); settleTimer = null; return; }
        refresh(true);
        if (++n >= maxTicks) { clearInterval(settleTimer); settleTimer = null; }
      }, 1000);
    }
    function settle(canEarlyStop) {
      if (settleTimer) clearInterval(settleTimer);
      let n = 0;
      const maxTicks = canEarlyStop ? 20 : 6; // ~8s cap vs ~2.4s ride-through
      refresh(true); // settle always (re)renders: establishes the board and re-attaches
      settleTimer = setInterval(function () {
        if (canEarlyStop && panelActive) { clearInterval(settleTimer); settleTimer = null; return; }
        refresh(true); // the observer to the CURRENT container as the thread hydrates/swaps
        if (++n >= maxTicks) {
          clearInterval(settleTimer);
          settleTimer = null;
          // Window over and still not a game? Hand off to the gentle tail —
          // a late-hydrating thread gets picked up instead of staying blank.
          if (!panelActive) settleLate();
        }
      }, 400);
    }
    // Initial mount settles WITH early-stop (no prior thread to get stuck on), so a
    // thread that hydrates a beat after we load — the normal case for a directly-
    // opened tweet permalink or a hard reload — is picked up rather than missed.
    settle(true);
    let lastHref = location.href;
    setInterval(function () {
      if (location.href !== lastHref) {
        lastHref = location.href;
        // New thread: a fresh #gage game pops up (reset minimize/close).
        uiDismissed = false;
        uiCollapsed = false;
        lastRenderSig = null; // new thread: force a fresh render
        authorRetries = 0; // new thread: fresh late-author grace budget
        if (authorRetryTimer) { clearTimeout(authorRetryTimer); authorRetryTimer = null; }
        settle(false); // ride through X's URL-before-DOM swap; no stale early-stop
      }
    }, 500);
    // Observer-death heartbeat. The MutationObserver anchors to the container
    // element captured at subscribe time; if the platform re-mounts that
    // container WITHOUT a URL change (Mastodon stream reconnect, X error-retry
    // re-mount), the observer watches a detached node forever and opponent moves
    // stop arriving — manual ↻ was the only recovery. Adapters expose the node
    // they observed on the disconnect handle (.root); when it falls out of the
    // document, tear down and force a refresh, which re-reads the live DOM and
    // re-subscribes to the CURRENT container. Low frequency on purpose: a
    // detached observer costs nothing while it waits, so 4s of lag is fine. No
    // false positives: a healthy root stays isConnected, and the document.body
    // fallback roots are always connected.
    setInterval(function () {
      if (
        panelActive &&
        disconnectObserver &&
        disconnectObserver.root &&
        !disconnectObserver.root.isConnected
      ) {
        teardownObserver();
        refresh(true); // re-render + re-observe against the re-mounted container
        // A remount can leave a GAP: the old container is gone but the new one
        // hasn't mounted yet, so the refresh above decides "not a game", flips
        // panelActive false, and this heartbeat's own guard would then never
        // retry — the panel stays dead with no URL change to rescue it. Hand
        // off to the same bounded 1s tail a slow post-nav hydration uses, so
        // the replacement container gets picked up when it lands. Guarded on
        // settleTimer so we never stack a second loop on a live settle.
        if (!panelActive && !settleTimer) settleLate();
      }
    }, 4000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountPanel);
  } else {
    mountPanel();
  }
})();
