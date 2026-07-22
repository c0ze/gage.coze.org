// DOM-coupled transport for Mastodon (standard web UI). Registers into
// window.Gage.transports.mastodon (a shared registry). select.js assigns
// window.Gage.threadTransport by hostname, so this file MUST NOT touch the DOM
// at load time — only inside its methods — and is safe to load on every match.
//
// The ONLY Gage file that touches a live Mastodon page. Selectors below were
// VERIFIED against live logged-in desktop Mastodon (mastodon.social) on
// 2026-07-22. Mastodon's web markup is shared across instances but unversioned —
// these class hooks WILL rot; if moves stop flowing, re-verify each against the
// live DOM (see VERIFIED SELECTORS).
//
// VERIFIED SELECTORS
//  [1] Thread container / observer root: .columns-area
//        (the scroll container that holds the status column). Its statuses are in
//        DOM order, root/oldest first.
//  [2] Post nodes, thread order (DOM order): .detailed-status (the focal post)
//        + .status (ancestors above it, descendants below). Read ALL of them in
//        DOM order. Text: .detailed-status__content (focal) / .status__content
//        .innerText (plain text; our move token is ASCII inside "[...]").
//  [3] Status id: a status's permalink a[href*="/@"] -> trailing /(\d+).
//        Identity + dedupe. (Mastodon permalinks look like /@acct/<id>.)
//  [4] Author handle (per post): .display-name__account -> "@user" (local) or
//        "@user@instance" (remote). Normalize: drop the leading "@", lowercase,
//        keep any "@instance" suffix (it disambiguates remote authors).
//  [5] My handle: .navigation-bar .account__display-name (fall back to the
//        .compose-form account). The acct text ("@gandtr") -> normalized handle.
//  [6] Reply control: within a post's .status__action-bar (focal:
//        .detailed-status__action-bar), the <button> whose title/aria-label
//        matches /repl/i (label "Reply").
//  [7] Compose editor: textarea.autosuggest-textarea__textarea — a REAL
//        React-CONTROLLED textarea. Setting .value directly is swallowed by
//        React; fill via the native value setter
//        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")
//        .set.call(ta, text) then dispatch a bubbling "input" Event so React's
//        onChange sees it. Verified working on live Mastodon 2026-07-22.
//  [8] Publish button: .compose-form .button--compact (labeled "Post").
//        AUTO_SEND=false -> fill only; the player clicks Post.
//  [9] Incoming replies: MutationObserver on [1] (childList+subtree) for added
//        .status; dedupe by [3].
//
// CONTRACT: readThreadMoves() returns RAW post texts in thread order; the caller
// (content.js) parses them via Gage.protocol.parseMove. postReply(text) fills the
// reply composer and, only if AUTO_SEND, clicks send — default OFF so a dev build
// never posts to Mastodon without the player pressing "Post" themselves.
//
// LIMITATION: readThreadMoves() only sees statuses currently in the DOM. Mastodon
// virtualizes long conversations, so a long game may need scrolling to fully
// hydrate before reconstruction is complete. (Fine for short games; revisit.)
(function () {
  const Gage = (window.Gage = window.Gage || {});
  Gage.transports = Gage.transports || {};

  const SEL = {
    container: ".columns-area",
    // Both focal (.detailed-status) and ancestor/descendant (.status) posts. A
    // detailed-status also carries a .status descendant in some layouts, so the
    // reader dedupes overlapping nodes (see postNodes()).
    detailed: ".detailed-status",
    status: ".status",
    detailedContent: ".detailed-status__content",
    statusContent: ".status__content",
    statusLink: 'a[href*="/@"]',
    author: ".display-name__account",
    detailedActionBar: ".detailed-status__action-bar",
    actionBar: ".status__action-bar",
    editor: "textarea.autosuggest-textarea__textarea",
    publish: ".compose-form .button--compact",
    // Identity read (verified live 2026-07-22):
    //  [10] Logged-in user: the navigation bar's account display name; fall back
    //       to the compose form's account block.
    navAccount: ".navigation-bar .account__display-name",
    composeAccount: ".compose-form .account__display-name",
  };
  // Dev-safe: fill the reply but let the player click "Post". Flip to true for
  // hands-free posting once the full game flow is trusted.
  const AUTO_SEND = false;

  const container = () => document.querySelector(SEL.container) || document.body;

  // postNodes() -> the thread's posts as an ORDERED, DEDUPED array of elements.
  // A .detailed-status can contain a nested .status (or vice-versa in some
  // layouts), and querying both selectors separately would double-count / reorder
  // them. Query the union in DOM order and drop any node contained by an earlier
  // kept node so each logical post appears exactly once, root first.
  function postNodes() {
    const all = Array.from(
      container().querySelectorAll(SEL.detailed + "," + SEL.status)
    );
    const kept = [];
    for (const node of all) {
      // Skip a node nested inside one we already kept (avoids the detailed/status
      // overlap emitting the same post twice).
      if (kept.some((k) => k !== node && k.contains(node))) continue;
      kept.push(node);
    }
    return kept;
  }

  // Prefer the detailed content when present (focal post), else the status
  // content. innerText only — plain text is all the protocol needs.
  function postTextOf(node) {
    const el =
      node.querySelector(SEL.detailedContent) ||
      node.querySelector(SEL.statusContent);
    // The focal node itself may BE the content container in trimmed layouts.
    if (el) return el.innerText;
    if (node.matches(SEL.detailedContent) || node.matches(SEL.statusContent)) {
      return node.innerText;
    }
    return node.innerText || "";
  }

  // A status's permalink is /@<acct>/<id>; the trailing digits are the id. Used
  // for identity + observer dedupe. null if no permalink is in the DOM yet
  // (Mastodon renders the shell before wiring the link on some transitions).
  function statusIdOf(node) {
    const href = Array.from(node.querySelectorAll(SEL.statusLink))
      .map((x) => x.getAttribute("href"))
      .find((h) => /\/@[^/]+\/\d+/.test(h || ""));
    const m = href && href.match(/\/@[^/]+\/(\d+)/);
    return m ? m[1] : null;
  }

  // "@user" -> "user"; "@user@instance" -> "user@instance". Strip a single
  // leading "@", lowercase, keep any "@instance" suffix (it disambiguates remote
  // authors). Trims surrounding whitespace the display node may include. Returns
  // null for empty / non-handle input so callers can treat it as unknown.
  function normalizeHandle(raw) {
    if (!raw) return null;
    const h = String(raw).trim().replace(/^@/, "").toLowerCase();
    return h || null;
  }

  // authorHandleOf(node) -> normalized handle of the post's author, or null.
  // Reads the post's own .display-name__account so an embedded/quoted account
  // never leaks in as the author (query the FIRST one in DOM order, which is the
  // post's own header).
  function authorHandleOf(node) {
    const el = node.querySelector(SEL.author);
    return el ? normalizeHandle(el.textContent) : null;
  }

  // getMyHandle() -> string|null. The logged-in user's handle, lowercased, no
  // leading "@". Reads the navigation bar's account block; falls back to the
  // compose form's account. null when logged out or neither block is in the DOM.
  //
  // The .account__display-name block WRAPS both the human display name and the
  // acct (@handle) in a nested .display-name__account, so reading the wrapper's
  // textContent would yield "Display Name@handle". Prefer the nested account
  // element (same node the per-post author read uses) and only fall back to the
  // wrapper's own text if that inner node isn't present.
  function getMyHandle() {
    const block =
      document.querySelector(SEL.navAccount) ||
      document.querySelector(SEL.composeAccount);
    if (!block) return null;
    const acct = block.querySelector(SEL.author) || block;
    return normalizeHandle(acct.textContent);
  }

  // getRootAuthorHandle() -> string|null. The author of the FIRST post in the
  // thread (the root / challenge), lowercased, no leading "@". The first node in
  // DOM order is the oldest ancestor (or the focal post if it has no ancestors).
  // null if no post is present yet.
  function getRootAuthorHandle() {
    const nodes = postNodes();
    if (!nodes.length) return null;
    return authorHandleOf(nodes[0]);
  }

  // Poll until getter() returns truthy or we time out (Mastodon renders async;
  // the composer mounts a tick after the reply button is clicked).
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

  // Within a post, find the reply <button>.
  //
  // FINDING THE BAR (verified live on mastodon.social, 2026-07-22): a regular
  // .status row CONTAINS its .status__action-bar, but the FOCAL post's bar is
  // NOT inside .detailed-status — it's a sibling under the shared
  // .detailed-status__wrapper (the .detailed-status node has ZERO buttons). The
  // original in-node-only lookup therefore failed exactly when the reply target
  // was the focal post — arda opening the rival's reply from a notification
  // makes that reply focal, so postReply threw and the move visually reverted.
  // So: in-node bar first (status rows), then climb to the wrapper (focal), then
  // the page-level bar (unique — one focal post per thread page) as a last hop.
  //
  // PICKING THE BUTTON (locale-proof), in preference order:
  // (1) the reply ICON — <i class="icon icon-reply"> ("icon-reply-all" on the
  //     focal bar); icon classes don't localize, while a label regex silently
  //     broke non-English UIs ("Yanıtla", "返信" never match /repl/i).
  // (2) title/aria-label matching /repl/i — fallback if the icon markup drifts.
  // (3) the FIRST button of a real action bar — Mastodon's order is fixed
  //     (reply, boost, favourite, bookmark, more). Only when the bar itself was
  //     found; guessing across the whole post would be worse than failing loudly.
  function replyButtonOf(node) {
    let bar =
      node.querySelector(SEL.detailedActionBar) ||
      node.querySelector(SEL.actionBar);
    if (!bar) {
      const wrapper = node.closest(".detailed-status__wrapper");
      bar = wrapper ? wrapper.querySelector(SEL.detailedActionBar) : null;
      // Last hop: the page's one focal action bar — but ONLY for the focal post
      // itself, never as a stand-in for some other row's missing bar.
      if (!bar && (node.matches(SEL.detailed) || node.querySelector(SEL.detailed))) {
        bar = document.querySelector(SEL.detailedActionBar);
      }
    }
    const scope = bar || node;
    const buttons = Array.from(scope.querySelectorAll("button"));
    const byIcon = buttons.find((b) => b.querySelector('[class*="icon-reply"]'));
    if (byIcon) return byIcon;
    const byLabel = buttons.find((b) => {
      const label = (b.getAttribute("title") || b.getAttribute("aria-label") || "");
      return /repl/i.test(label);
    });
    if (byLabel) return byLabel;
    return bar && buttons.length ? buttons[0] : null;
  }

  // Fill a React-controlled <textarea> so React's onChange actually fires. React
  // installs its own value setter on the instance, so a plain ta.value = text is
  // swallowed; call the NATIVE prototype setter, then dispatch a bubbling "input"
  // Event so React's synthetic onChange picks up the new value.
  function setControlledTextarea(ta, text) {
    const desc = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    );
    if (desc && desc.set) {
      desc.set.call(ta, String(text));
    } else {
      ta.value = String(text); // last-resort fallback
    }
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // readThreadMoves() -> string[]  RAW post texts, thread order (root first).
  function readThreadMoves() {
    return postNodes().map(postTextOf);
  }

  // postReply(text) -> Promise. Opens a reply to the LATEST (newest) post in the
  // thread and fills `text` into the compose textarea; clicks Post only if
  // AUTO_SEND. Rejects (does not swallow) so the UI can surface a failure.
  async function postReply(text) {
    const nodes = postNodes();
    const target = nodes[nodes.length - 1]; // newest post keeps the chain nested
    if (!target) throw new Error("[gage] postReply: no post to reply to");
    const replyBtn = replyButtonOf(target);
    if (!replyBtn) throw new Error("[gage] postReply: no reply control on target post");
    replyBtn.click();

    // The compose textarea exists PERMANENTLY in Mastodon's left column, so the
    // editor alone can't tell reply mode from a plain toot: if the click no-ops,
    // filling would produce a NON-THREADED toot that silently forks the game. The
    // .reply-indicator block renders only while the composer is in reply mode —
    // AND it must reference OUR target post: a pre-existing indicator (the user
    // was mid-reply to something else) or a wrong-bar click would otherwise pass
    // the gate and fill the wrong thread. The indicator quotes the target's body
    // through the same content renderer readThreadMoves uses, so a short prefix
    // of postTextOf(target) appears verbatim in indicator.innerText (verified
    // live 2026-07-22; short because the indicator truncates long posts). An
    // empty target text (image-only post) can't be matched — accept any
    // indicator rather than making such replies impossible.
    const wantPrefix = String(postTextOf(target) || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 16);
    try {
      await waitFor(() => {
        const el = document.querySelector(".reply-indicator");
        if (!el) return null;
        if (!wantPrefix) return el;
        const got = (el.innerText || "").replace(/\s+/g, " ");
        return got.indexOf(wantPrefix) !== -1 ? el : null;
      });
    } catch (e) {
      throw new Error("[gage] postReply: reply mode didn't engage on the target post");
    }
    const editor = await waitFor(() => document.querySelector(SEL.editor));
    editor.focus();
    // React owns this textarea; the native-setter + input-event dance below is
    // what makes React commit our text (see setControlledTextarea). Mastodon
    // prefills the composer with "@opponent " — the opponent's reply NOTIFICATION
    // rides on that mention, so when the current contents are purely a mention
    // block we KEEP it and append our move text. Anything else (a stale human
    // draft) is replaced wholesale, as before.
    const prefill = /^(@\S+\s*)+$/.test(editor.value)
      ? editor.value.replace(/\s*$/, " ")
      : "";
    setControlledTextarea(editor, prefill + String(text));

    // Only when AUTO_SEND is on do we need the Post button: wait for it to exist
    // AND be enabled (Mastodon disables it until the composer has content; our
    // input event enables it a tick later), then click. With AUTO_SEND off the
    // fill is the whole job — do NOT block on the button, or a rename/disable of
    // it would turn a successful fill into a spurious timeout rejection.
    if (AUTO_SEND) {
      const publish = await waitFor(() => {
        const b = document.querySelector(SEL.publish);
        return b && !b.disabled && b.getAttribute("aria-disabled") !== "true" ? b : null;
      });
      publish.click();
    }
    return { filled: true, sent: AUTO_SEND };
  }

  // observe(onNewMove) -> disconnect(). Fires onNewMove(rawText) once per newly
  // added, hydrated .status (deduped by status id). Mastodon may render a status
  // shell before its permalink/text hydrate, so we:
  //   (a) tag every post present at subscribe time (a DOM expando) so it can
  //       never be mistaken for "new" even before it hydrates or gets an id;
  //   (b) watch childList + attributes(href) + characterData so hydration
  //       triggers a rescan;
  //   (c) only record/emit once a post has an id AND non-empty text — the rest
  //       are retried on later mutations.
  // Scans are coalesced and cancelled on disconnect so nothing fires after
  // unsubscribe. NOTE: treat this as a "thread changed" nudge — the orchestration
  // should re-read via readThreadMoves() as the source of truth rather than trust
  // a single emit (robust to Mastodon's node recycling on scroll).
  function observe(onNewMove) {
    const root = container();
    const PRE = Symbol("gagePre"); // unique per observe() call — no cross-observer collision
    const known = new Set();
    for (const a of postNodes()) {
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
      for (const a of postNodes()) {
        if (stopped) return; // caller may disconnect() from within onNewMove
        if (a[PRE]) continue; // present at subscribe time -> never "new"
        const id = statusIdOf(a);
        if (!id || known.has(id)) continue;
        const text = postTextOf(a);
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

  Gage.transports.mastodon = {
    readThreadMoves,
    postReply,
    observe,
    getMyHandle,
    getRootAuthorHandle,
    SELECTORS: SEL,
    AUTO_SEND,
  };
})();
