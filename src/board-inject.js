// Inject a board IMAGE under each #gage MOVE reply, so anyone with the extension
// sees the game play inline on Bluesky — which (unlike X and Mastodon) does NOT
// unfurl our /g/ link into a card. Purely additive + idempotent: it renders each
// position client-side (board-image.js) and drops a small PNG under the reply's
// text, deduped by the position key so re-renders don't pile up and a recycled
// node gets its board back. Best-effort: never throws into the page.
//
// Scope: Bluesky only — on X/Mastodon every post already unfurls the native
// card. The ROOT gets a board too: bsky challenges are linkless (the raw /g/
// URL counted toward the 300-grapheme limit), so the injected board is the
// opening position's only visual there.
(function () {
  const Gage = (window.Gage = window.Gage || {});

  function boardDataUrl(game, state) {
    const size = game.boardSize || { rows: 8, cols: 8 };
    const span = Math.max(size.rows, size.cols) || 8;
    const cell = Math.max(14, Math.floor(300 / span)); // ~300px board; floor keeps 15x15 legible
    const canvas = Gage.renderBoardCanvas(game, state, { cell: cell });
    return canvas.toDataURL("image/png");
  }

  // Drop (or refresh) the board under `post` for `state`, deduped by position key.
  // Returns the board element we placed/kept (so the caller can sweep away any
  // board it did NOT claim this pass), or null if nothing was rendered.
  function injectBoardInto(game, state, post) {
    if (!post || !post.node) return null;
    const key = typeof Gage.positionKey === "function" ? Gage.positionKey(game, state) : "";
    const mine = post.node.querySelector('img.gage-thread-board[data-gage="1"]');
    if (mine) {
      if (mine.getAttribute("data-key") === key) return mine; // already the right board
      mine.remove(); // stale — re-render below
    }
    const img = document.createElement("img");
    img.className = "gage-thread-board";
    img.setAttribute("data-gage", "1");
    img.setAttribute("data-key", key);
    img.alt = "Gage board";
    img.src = boardDataUrl(game, state); // may throw -> caught by injectThreadBoards
    const anchor = post.anchor;
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(img, anchor.nextSibling);
    } else {
      post.node.appendChild(img);
    }
    return img;
  }

  // injectThreadBoards(game): walk the thread's posts, replay each move, and inject
  // the board for the position AFTER that move into its reply. Stops at the first
  // illegal move (a desync — the position past it is unknown).
  function injectThreadBoards(game) {
    const tt = Gage.threadTransport;
    if (!game || Gage.platform !== "bluesky") return; // only bsky replies lack a native card
    if (!tt || typeof tt.postElements !== "function") return;
    if (typeof Gage.renderBoardCanvas !== "function" || !Gage.protocol || !Gage.protocol.parseMove) return;
    // The whole walk is wrapped so a bad state / renderer can NEVER throw into the
    // caller (content.js refresh) and disturb gameplay — boards are pure decoration.
    try {
      const posts = tt.postElements();
      if (!posts || !posts.length) return;
      const claimed = new Set(); // boards we placed/kept this pass
      // Gate moves by AUTHORSHIP through the same collectMovePosts the panel's
      // decide() uses — an outsider's legal-looking "[e5] #gage" reply must not
      // render a divergent inline board (it isn't part of the game). Falls back
      // to the ungated walk only if orchestration isn't loaded (manifest order
      // makes that impossible in practice, but boards are decoration — degrade,
      // don't die).
      const orch = Gage.orchestration;
      let accepted; // [{ index, moveText }] into `posts`
      if (orch && orch.collectMovePosts && tt.getRootAuthorHandle) {
        const white = tt.getRootAuthorHandle();
        const black = orch.firstRivalMention
          ? orch.firstRivalMention(posts[0].text, white)
          : null;
        accepted = orch.collectMovePosts(posts, Gage.protocol, white, black).moves;
      } else {
        accepted = [];
        for (let i = 0; i < posts.length; i++) {
          const parsed = Gage.protocol.parseMove(posts[i].text);
          if (parsed) accepted.push({ index: i, moveText: parsed.moveText });
        }
      }
      let state = game.initialState();
      for (const mv of accepted) {
        const next = game.applyMoveText(state, mv.moveText);
        if (!next) break; // desync — stop (position past here is unknown)
        state = next;
        // The ROOT gets a board too: bsky challenges are now LINKLESS (the raw
        // /g/ URL blew the 300-grapheme limit), so there's no native card on
        // the root — the injected board is the opening position's only visual.
        try {
          const img = injectBoardInto(game, state, posts[mv.index]);
          if (img) claimed.add(img);
        } catch (e) { /* skip just this board */ }
      }
      // Sweep: remove any board we did NOT claim this pass — a stale image left on a
      // recycled node, a non-move post, or a post past a desync would otherwise show
      // a wrong/old position. (Cheap: there are only a handful of these.)
      for (const el of document.querySelectorAll('img.gage-thread-board[data-gage="1"]')) {
        if (!claimed.has(el)) el.remove();
      }
    } catch (e) {
      /* best-effort — never break the host page */
    }
  }

  // Remove every injected board. content.js calls this when the thread is no longer
  // a #gage game (SPA nav to a non-game page), so a recycled outgoing node can't keep
  // showing a stale board — the in-game sweep only runs while a game is recognized.
  function clearThreadBoards() {
    try {
      const boards = document.querySelectorAll('img.gage-thread-board[data-gage="1"]');
      for (const el of boards) el.remove();
    } catch (e) {
      /* best-effort */
    }
  }

  Gage.injectThreadBoards = injectThreadBoards;
  Gage.clearThreadBoards = clearThreadBoards;
})();
