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

  Gage.threadTransport = { readThreadMoves, postReply, observe, SELECTORS: SEL, AUTO_SEND };
})();
