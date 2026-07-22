// Inject a board IMAGE under each #gage MOVE reply, so anyone with the extension
// sees the game play inline on Bluesky — which (unlike X and Mastodon) does NOT
// unfurl our /g/ link into a card. Purely additive + idempotent: it renders each
// position client-side (board-image.js) and drops a small PNG under the reply's
// text, deduped by the position key so re-renders don't pile up and a recycled
// node gets its board back. Best-effort: never throws into the page.
//
// Scope: Bluesky only. On X/Mastodon the reply already shows the native card, and
// the ROOT challenge post has a card on every platform (created via the compose
// intent), so we skip the first move too.
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
      let state = game.initialState();
      let moveNo = 0;
      for (const post of posts) {
        const parsed = Gage.protocol.parseMove(post.text);
        if (!parsed) continue; // chatter / non-move post — no board
        const next = game.applyMoveText(state, parsed.moveText);
        if (!next) break; // desync — stop (position past here is unknown)
        state = next;
        moveNo++;
        if (moveNo === 1) continue; // the root challenge already has the native card
        try {
          const img = injectBoardInto(game, state, post);
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
