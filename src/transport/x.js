// DOM-coupled transport for X (Twitter). window.Gage.threadTransport.
//
// The ONLY Gage file that touches the live X page. Selectors below were VERIFIED
// against live logged-in desktop X on 2026-07-22. X ships no stable API here —
// these are reverse-engineered data-testids and WILL rot; if moves stop flowing,
// re-verify each against the live DOM (see VERIFIED SELECTORS).
//
// VERIFIED SELECTORS
//  [1] Thread container / observer root: div[aria-label^="Timeline:"]
//        ("Timeline: Conversation" on a status page; "Timeline: Your Home
//        Timeline" on home). Holds the tweet cells in DOM order, root first.
//  [2] Tweet node: article[data-testid="tweet"] (each inside a
//        [data-testid="cellInnerDiv"] cell). Text: [data-testid="tweetText"]
//        .innerText (plain text; our move token is ASCII inside "[...]").
//  [3] Status id: a[href*="/status/"] -> /status/(\d+)/. Identity + dedupe.
//  [4] Reply composer editable: [data-testid="tweetTextarea_0"] (DraftJS
//        contenteditable; .value / textContent are inert). Fill via focus() +
//        document.execCommand("insertText", false, text) — verified working.
//  [5] Send button: [data-testid="tweetButtonInline"] (labeled "Reply");
//        aria-disabled="true" until the editor has text, then it can be clicked.
//  [6] Open a reply scoped to a tweet: click that article's
//        [data-testid="reply"]. Cancel without posting: [data-testid=
//        "app-bar-close"] then the "Discard" confirmation.
//  [7] Incoming replies: MutationObserver on [1] (childList+subtree) for added
//        article[data-testid="tweet"]; dedupe by [3].
//
// CONTRACT: readThreadMoves() returns RAW tweet texts in thread order; the caller
// (content.js) parses them via Gage.protocol.parseMove. postReply(text) fills the
// reply composer and, only if AUTO_SEND, clicks send — default OFF so a dev build
// never posts to X without the player pressing "Reply" themselves.
//
// LIMITATION: readThreadMoves() only sees tweets currently in the DOM. X lazily
// loads long conversations, so a long game may need scrolling to fully hydrate
// before reconstruction is complete. (Fine for short games; revisit later.)
(function () {
  const Gage = (window.Gage = window.Gage || {});

  const SEL = {
    container: 'div[aria-label^="Timeline:"]',
    article: 'article[data-testid="tweet"]',
    tweetText: '[data-testid="tweetText"]',
    statusLink: 'a[href*="/status/"]',
    reply: '[data-testid="reply"]',
    editor: '[data-testid="tweetTextarea_0"]',
    send: '[data-testid="tweetButtonInline"]',
    // Identity reads (verified live 2026-07-22):
    //  [8] Logged-in user: the profile tab link -> href "/<handle>".
    //  [9] A tweet's author: its User-Name block's first profile link -> href
    //      "/<handle>" (scoped to ONE article so we can read the ROOT author).
    profileLink: 'a[data-testid="AppTabBar_Profile_Link"]',
    userName: '[data-testid="User-Name"]',
  };
  // Dev-safe: fill the reply but let the player click "Reply". Flip to true for
  // hands-free posting once the full game flow is trusted.
  const AUTO_SEND = false;

  const container = () => document.querySelector(SEL.container) || document.body;

  function statusIdOf(article) {
    const href = Array.from(article.querySelectorAll(SEL.statusLink))
      .map((x) => x.getAttribute("href"))
      .find((h) => /\/status\/\d+/.test(h || ""));
    const m = href && href.match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  }

  function tweetTextOf(article) {
    const el = article.querySelector(SEL.tweetText);
    return el ? el.innerText : "";
  }

  // "/Rival" | "/rival/" | "/rival/status/1" -> "rival". Handles are the first
  // path segment; drop a leading "@" too and lowercase. Anything without a real
  // segment (e.g. "/", "/home") yields null so callers can treat it as unknown.
  // X's own routes are not user handles; a link to one must never be mistaken for
  // a player (the doc comment above promised "/home" -> null).
  const RESERVED_ROUTES = new Set([
    "home", "explore", "notifications", "messages", "i", "settings", "compose",
    "search", "hashtag", "bookmarks", "lists", "topics", "jobs", "tos", "privacy",
    "login", "logout", "signup",
  ]);
  function handleFromHref(href) {
    if (!href) return null;
    const seg = String(href).replace(/^https?:\/\/[^/]+/i, "").split("/")[1];
    if (!seg) return null;
    const h = seg.replace(/^@/, "").toLowerCase();
    if (!h || RESERVED_ROUTES.has(h)) return null;
    return h;
  }

  // getMyHandle() -> string|null. The logged-in user's handle, lowercased, no
  // "@"/"/". Reads the profile tab's href ("/<handle>"). null when logged out or
  // the tab isn't in the DOM (e.g. a page without the nav rail).
  function getMyHandle() {
    const a = document.querySelector(SEL.profileLink);
    return a ? handleFromHref(a.getAttribute("href")) : null;
  }

  // getRootAuthorHandle() -> string|null. The author of the FIRST tweet in the
  // thread (the root / challenge), lowercased, no "@"/"/". On a conversation page
  // the first article is the root; its User-Name block's first profile link is
  // the author. null if no tweet is present yet.
  function getRootAuthorHandle() {
    const root = container().querySelector(SEL.article);
    if (!root) return null;
    // No author block -> unknown. Do NOT fall back to the whole article: an
    // embedded / quoted tweet inside the root would inject a wrong profile link.
    const nameBlock = root.querySelector(SEL.userName);
    if (!nameBlock) return null;
    const link = Array.from(nameBlock.querySelectorAll('a[href^="/"]'))
      .map((x) => x.getAttribute("href"))
      // Skip in-tweet links that aren't the author profile (status/photo/etc.).
      .find((h) => h && !/\/(status|photo|search|hashtag|i)\b/.test(h));
    return handleFromHref(link);
  }

  // Poll until getter() returns truthy or we time out (X renders async).
  function waitFor(getter, opts) {
    const { timeout = 6000, interval = 100 } = opts || {};
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function tick() {
        let v = null;
        try { v = getter(); } catch (e) { v = null; }
        if (v) return resolve(v);
        if (Date.now() - t0 > timeout) return reject(new Error("[gage] waitFor timed out"));
        setTimeout(tick, interval);
      })();
    });
  }

  // readThreadMoves() -> string[]  RAW tweet texts, thread order (root first).
  function readThreadMoves() {
    return Array.from(container().querySelectorAll(SEL.article)).map(tweetTextOf);
  }

  // postReply(text) -> Promise. Opens a reply to the LATEST tweet in the thread
  // and fills `text` into the DraftJS editor; clicks send only if AUTO_SEND.
  // Rejects (does not swallow) so the UI can surface a failure.
  async function postReply(text) {
    const arts = Array.from(container().querySelectorAll(SEL.article));
    const target = arts[arts.length - 1]; // newest tweet keeps the chain nested
    if (!target) throw new Error("[gage] postReply: no tweet to reply to");
    const replyBtn = target.querySelector(SEL.reply);
    if (!replyBtn) throw new Error("[gage] postReply: no reply control on target tweet");
    replyBtn.click();

    const editor = await waitFor(() => document.querySelector(SEL.editor));
    editor.focus();
    // DraftJS ignores .value/textContent; execCommand dispatches the beforeinput
    // that makes DraftJS update its model. Verified on live X 2026-07-22.
    //
    // CLEAR-THEN-INSERT: X persists an unsent draft in the reply composer, so a
    // bare insertText APPENDS our move onto whatever was already there (a
    // half-typed reply, or our own text from a prior open that wasn't sent) —
    // the "doubled / crowded reply" bug. selectAll first so the insert REPLACES
    // the composer's contents; on an empty composer selectAll is a no-op and this
    // just inserts. (selectAll only moves the selection; it's insertText that
    // fires the beforeinput DraftJS updates from, replacing whatever is selected.)
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, String(text));

    const send = await waitFor(() => {
      const b = document.querySelector(SEL.send);
      return b && b.getAttribute("aria-disabled") !== "true" ? b : null;
    });
    if (AUTO_SEND) send.click();
    return { filled: true, sent: AUTO_SEND };
  }

  // observe(onNewMove) -> disconnect(). Fires onNewMove(rawText) once per newly
  // added, fully-hydrated tweet (deduped by status id). X renders a tweet's
  // article shell BEFORE its id (an <a href>) and text, and may fill them via
  // attribute or characterData mutations, so we:
  //   (a) tag every article present at subscribe time (a DOM expando) so it can
  //       never be mistaken for "new" even before it hydrates or gets an id;
  //   (b) watch childList + attributes(href) + characterData so hydration
  //       triggers a rescan;
  //   (c) only record/emit once an article has an id AND non-empty text — the
  //       rest are retried on later mutations.
  // Scans are coalesced and cancelled on disconnect so nothing fires after
  // unsubscribe. NOTE: treat this as a "thread changed" nudge — the orchestration
  // should re-read via readThreadMoves()+reconstruct() as the source of truth
  // rather than trust a single emit (robust to X's node recycling).
  function observe(onNewMove) {
    const root = container();
    const PRE = Symbol("gagePre"); // unique per observe() call — no cross-observer collision
    const known = new Set();
    for (const a of root.querySelectorAll(SEL.article)) {
      a[PRE] = true;
      const id = statusIdOf(a);
      if (id) known.add(id);
    }
    let scheduled = false;
    let stopped = false;
    let timer = null;
    function scan() {
      scheduled = false;
      timer = null;
      if (stopped) return;
      for (const a of root.querySelectorAll(SEL.article)) {
        if (stopped) return; // caller may disconnect() from within onNewMove
        if (a[PRE]) continue; // present at subscribe time -> never "new"
        const id = statusIdOf(a);
        if (!id || known.has(id)) continue;
        const text = tweetTextOf(a);
        if (!text) continue; // not hydrated yet — a later mutation retries
        known.add(id);
        try { onNewMove(text); } catch (e) { /* caller's error */ }
      }
    }
    const mo = new MutationObserver(() => {
      if (stopped || scheduled) return;
      scheduled = true;
      timer = setTimeout(scan, 0); // coalesce a burst of mutations into one scan
    });
    mo.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href"],
      characterData: true,
    });
    return function disconnect() {
      stopped = true;
      mo.disconnect();
      if (timer) { clearTimeout(timer); timer = null; }
    };
  }

  Gage.transports = Gage.transports || {};
  Gage.transports.x = {
    readThreadMoves,
    postReply,
    observe,
    getMyHandle,
    getRootAuthorHandle,
    SELECTORS: SEL,
    AUTO_SEND,
  };
})();
