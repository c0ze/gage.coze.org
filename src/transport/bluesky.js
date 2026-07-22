// DOM-coupled transport for Bluesky (bsky.app). Registers into the shared
// registry as window.Gage.transports.bluesky (select.js later assigns
// window.Gage.threadTransport by hostname).
//
// The ONLY Gage file that touches the live Bluesky page. This is an IIFE that
// registers its methods but MUST NOT touch the DOM at load time — every DOM read
// happens inside a method — so it is safe to load on every matched host. Selectors
// below were VERIFIED against live logged-in desktop Bluesky on 2026-07-22.
// Bluesky's web app is react-native-web; it ships no stable public DOM here, so
// these are reverse-engineered data-testids and WILL rot. If moves stop flowing,
// re-verify each against the live DOM (see VERIFIED SELECTORS).
//
// VERIFIED SELECTORS (bsky.app, 2026-07-22)
//  [1] Thread post node: [data-testid^="postThreadItem-by-"] — one per post on a
//        thread page, in DOM order (ancestors -> focal -> replies), i.e. root/
//        oldest first. The testid suffix after "postThreadItem-by-" is the author
//        handle (e.g. postThreadItem-by-otter.gg). (A feed uses feedItem-by-*
//        instead; we only read the thread items.)
//  [2] Post text: FEED items expose [data-testid="postText"], but THREAD items
//        (postThreadItem-*) do NOT — a thread page has ZERO postText testids
//        (verified live 2026-07-22). postTextOf() prefers postText when present,
//        else the largest <div dir="auto"> block not inside a link (the body).
//        A post may legitimately have no text (image-only) -> "".
//  [3] Author handle: the [1] testid suffix after "postThreadItem-by-", OR the
//        item's a[href^="/profile/<handle>"]. Normalize (drop "@", lowercase).
//  [4] My handle: a[aria-label="Profile"][href^="/profile/"] -> /profile/<handle>.
//        null when logged out or the nav isn't rendered.
//  [5] Reply control: [data-testid="replyBtn"] within the item.
//  [6] Composer editable: [data-testid="composePostView"] [contenteditable="true"]
//        — a Tiptap/ProseMirror editor with NO testid of its own (verified live
//        2026-07-22). .value is inert; fill via focus() + document.execCommand(
//        "selectAll"/"insertText", ...), same approach as the X DraftJS path
//        (verified: the execCommand insert commits into the ProseMirror model and
//        enables Publish).
//  [7] Publish button: [data-testid="composerPublishBtn"]. AUTO_SEND=false -> we
//        fill only and the human clicks Publish.
//  [8] Incoming replies: MutationObserver on the thread container (childList+
//        subtree) for added [data-testid^="postThreadItem-by-"]; dedupe by post id
//        = the <author>/<rkey> from the /post/ permalink (per-post-unique; the
//        testid alone is only author-scoped, so it is NOT used for dedupe).
//
// CONTRACT (identical to thread-dom.js / the X adapter): readThreadMoves() returns
// RAW post texts in thread order (root first); the caller (content.js) parses them
// via Gage.protocol.parseMove. postReply(text) opens the reply composer for the
// LAST (newest) post and fills it, clicking Publish only if AUTO_SEND — default OFF
// so a dev build never posts to Bluesky without the player pressing Publish.
//
// LIMITATION: readThreadMoves() only sees posts currently in the DOM. Bluesky
// lazily loads long threads, so a long game may need scrolling to fully hydrate
// before reconstruction is complete. (Fine for short games; revisit later.)
//
// COMPOSER OPEN (verified live 2026-07-22): a synthetic replyBtn.click() DOES open
// the reply composer and execCommand fills its ProseMirror editable — the earlier
// failure was an unverified-account "verify your email" gate, not the click.
// postReply clicks, polls for the composer editable, fills it, and (AUTO_SEND off)
// leaves Publish to the human. NOTE: a Bluesky account whose email is unverified
// cannot post at all — that is a platform gate, surfaced as its own modal.
(function () {
  const Gage = (window.Gage = window.Gage || {});
  Gage.transports = Gage.transports || {};

  const SEL = {
    // Thread post item; the testid suffix after "postThreadItem-by-" is the author.
    item: '[data-testid^="postThreadItem-by-"]',
    postText: '[data-testid="postText"]',
    // Any /profile/<handle> link (author link inside a post, or the nav Profile).
    profileLink: 'a[href^="/profile/"]',
    // A post's permalink -> /post/<rkey>; used for identity + observer dedupe.
    postLink: 'a[href*="/post/"]',
    reply: '[data-testid="replyBtn"]',
    // The composer editable is a Tiptap/ProseMirror contenteditable INSIDE
    // [data-testid="composePostView"] and has NO testid of its own (verified live
    // 2026-07-22) — scope to the compose view's contenteditable.
    editor: '[data-testid="composePostView"] [contenteditable="true"]',
    publish: '[data-testid="composerPublishBtn"]',
    // Logged-in user's own profile link in the nav rail.
    myProfileLink: 'a[aria-label="Profile"][href^="/profile/"]',
  };
  // Prefix we strip off an item's testid to recover the author handle.
  const ITEM_TESTID_PREFIX = "postThreadItem-by-";

  // Dev-safe: fill the reply but let the player click Publish. Flip to true for
  // hands-free posting once the full game flow is trusted.
  const AUTO_SEND = false;

  // Thread container = the nearest common scroll parent of the post items. Bluesky
  // has no stable "thread" testid, so we anchor the observer on the first item's
  // parent (or, if nothing rendered yet, document.body). Computed lazily inside
  // methods only — never at load time.
  function container() {
    const first = document.querySelector(SEL.item);
    return (first && first.parentElement) || document.body;
  }

  // "@Rival" | "rival.bsky.social" | "/profile/rival.bsky.social/post/1" -> the
  // handle, lowercased, no leading "@". Bluesky handles are full DNS-style names
  // (e.g. gand-tr.bsky.social) so we keep dots/hyphens; we only drop a leading "@"
  // and lowercase. Reserved bsky routes are not handles.
  const RESERVED_ROUTES = new Set([
    "home", "search", "notifications", "messages", "feeds", "lists", "settings",
    "profile", "post", "hashtag", "intent", "support", "tos", "privacy",
    "moderation", "login", "signup",
  ]);
  function normalizeHandle(raw) {
    if (!raw) return null;
    const h = String(raw).replace(/^@/, "").trim().toLowerCase();
    if (!h || RESERVED_ROUTES.has(h)) return null;
    return h;
  }
  // Pull the handle out of a /profile/<handle>[/...] href. The segment right after
  // "profile" is the handle (or a DID like did:plc:...; we keep it lowercased).
  function handleFromProfileHref(href) {
    if (!href) return null;
    const path = String(href).replace(/^https?:\/\/[^/]+/i, "");
    const m = path.match(/\/profile\/([^/?#]+)/i);
    return m ? normalizeHandle(decodeURIComponent(m[1])) : null;
  }

  // authorOf(item) -> string|null. Prefer the item's testid suffix (the most
  // stable signal — it names the post's own author, never an embedded/quoted
  // post's). Fall back to the first /profile/ link inside the item.
  function authorOf(item) {
    const testid = item.getAttribute("data-testid") || "";
    if (testid.startsWith(ITEM_TESTID_PREFIX)) {
      const h = normalizeHandle(testid.slice(ITEM_TESTID_PREFIX.length));
      if (h) return h;
    }
    const link = item.querySelector(SEL.profileLink);
    return link ? handleFromProfileHref(link.getAttribute("href")) : null;
  }

  // postIdOf(item) -> string|null. Stable id for dedupe: the <author>/<rkey> from
  // the post's permalink, so two different authors' posts never collide. Returns
  // null until the permalink has hydrated — the observer treats a null id as "not
  // ready yet" and retries on a later mutation. We deliberately do NOT fall back to
  // the item's testid: the testid is only author-scoped ("postThreadItem-by-<h>"),
  // so it (a) collides across multiple posts by the same author and (b) would let
  // one post emit once under the testid and AGAIN under its real id once the
  // permalink hydrates (a double-emit). The permalink is the only per-post-unique id.
  function postIdOf(item) {
    const href = Array.from(item.querySelectorAll(SEL.postLink))
      .map((x) => x.getAttribute("href"))
      .find((h) => /\/post\//.test(h || ""));
    const m = href && href.match(/\/profile\/([^/?#]+)\/post\/([^/?#]+)/i);
    return m ? `${m[1].toLowerCase()}/${m[2]}` : null;
  }

  // postTextOf(item) -> the post's BODY text. Bluesky's FEED items carry a
  // [data-testid="postText"], but THREAD items (postThreadItem-by-*) do NOT —
  // VERIFIED live 2026-07-22: a thread page has ZERO postText testids; the body is
  // an unlabeled <div dir="auto"> (react-native-web). So prefer postText when
  // present (feeds / future builds) and otherwise fall back to the LARGEST
  // dir="auto" block that is not ITSELF inside a link. In-body hashtag/mention
  // links (e.g. "#gage", "@rival") are <a> NESTED inside that block, so they
  // survive in .innerText; the author name/handle/timestamp — which ARE inside
  // links — are excluded, so a bracketed display name can't shadow the "[move]"
  // slot the protocol reads.
  function postTextOf(item) {
    const tagged = item.querySelector(SEL.postText);
    if (tagged && tagged.innerText.trim()) return tagged.innerText;
    let best = "";
    for (const el of item.querySelectorAll('div[dir="auto"]')) {
      if (el.closest("a")) continue; // skip the author/handle/time links
      const t = el.innerText || "";
      if (t.length > best.length) best = t;
    }
    return best;
  }

  // Poll until getter() returns truthy or we time out (Bluesky renders async, and
  // the composer in particular opens a beat after the reply click).
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

  // getMyHandle() -> string|null. The logged-in user's handle, lowercased, no "@".
  // Reads the nav rail Profile link ("/profile/<handle>"). null when logged out or
  // the nav isn't in the DOM (e.g. a page without the rail).
  function getMyHandle() {
    const a = document.querySelector(SEL.myProfileLink);
    return a ? handleFromProfileHref(a.getAttribute("href")) : null;
  }

  // getRootAuthorHandle() -> string|null. The author of the FIRST post in the
  // thread (the root / challenge), lowercased, no "@". On a thread page the first
  // post item in DOM order is the root. null if no post is present yet.
  function getRootAuthorHandle() {
    const root = document.querySelector(SEL.item);
    return root ? authorOf(root) : null;
  }

  // readThreadMoves() -> string[]  RAW post texts, thread order (root/oldest first).
  // DOM order of the thread items already IS thread order.
  function readThreadMoves() {
    return Array.from(document.querySelectorAll(SEL.item)).map(postTextOf);
  }

  // postReply(text) -> Promise. Opens a reply to the LATEST post in the thread and
  // fills `text` into the ProseMirror composer; clicks Publish only if AUTO_SEND.
  // Rejects (does not swallow) so the UI can surface a failure.
  async function postReply(text) {
    const items = Array.from(document.querySelectorAll(SEL.item));
    const target = items[items.length - 1]; // newest post keeps the chain nested
    if (!target) throw new Error("[gage] postReply: no post to reply to");
    const replyBtn = target.querySelector(SEL.reply);
    if (!replyBtn) throw new Error("[gage] postReply: no reply control on target post");

    // LIVE-VERIFICATION RISK: a synthetic .click() did NOT open the composer in
    // react-native-web testing. We click and then poll for the composer input; if
    // it never appears we reject so the caller can surface it (and we can wire a
    // fallback trigger — composeFAB or the compose intent URL — later).
    replyBtn.click();

    let editor;
    try {
      editor = await waitFor(() => document.querySelector(SEL.editor));
    } catch (e) {
      throw new Error(
        "[gage] postReply: composer did not open after clicking reply " +
          "(react-native-web may require a trusted gesture; re-verify live)"
      );
    }

    editor.focus();
    // ProseMirror (like DraftJS) ignores .value/textContent; execCommand dispatches
    // the beforeinput events the editor updates its model from. CLEAR-THEN-INSERT:
    // an unsent draft may persist in the composer, so a bare insertText would APPEND
    // onto whatever was there. selectAll first so the insert REPLACES the contents;
    // on an empty composer selectAll is a no-op.
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, String(text));

    // Wait for the publish button; on Bluesky it exists once the composer is open.
    // (We do not require an aria-disabled flip — the editor now holds our text.)
    const publish = await waitFor(() => document.querySelector(SEL.publish));
    if (AUTO_SEND) publish.click();
    return { filled: true, sent: AUTO_SEND };
  }

  // observe(onNewMove) -> disconnect(). Fires onNewMove(rawText) once per newly
  // added, fully-hydrated post (deduped by post id). Bluesky renders a post item's
  // shell BEFORE its permalink/text, and may fill them via attribute/characterData
  // mutations, so we:
  //   (a) tag every item present at subscribe time (a DOM expando) so it can never
  //       be mistaken for "new" even before it hydrates or gets a permalink;
  //   (b) watch childList + attributes(href) + characterData so hydration triggers
  //       a rescan;
  //   (c) only record/emit once an item has an id AND non-empty text — the rest are
  //       retried on later mutations.
  // Scans are coalesced and cancelled on disconnect so nothing fires after
  // unsubscribe. NOTE: treat this as a "thread changed" nudge — the orchestration
  // should re-read via readThreadMoves() as the source of truth rather than trust a
  // single emit (robust to Bluesky's node recycling).
  function observe(onNewMove) {
    const root = container();
    const PRE = Symbol("gagePre"); // unique per observe() call — no cross-observer collision
    const known = new Set();
    for (const it of root.querySelectorAll(SEL.item)) {
      it[PRE] = true;
      const id = postIdOf(it);
      if (id) known.add(id);
    }
    let scheduled = false;
    let stopped = false;
    let timer = null;
    function scan() {
      scheduled = false;
      timer = null;
      if (stopped) return;
      for (const it of root.querySelectorAll(SEL.item)) {
        if (stopped) return; // caller may disconnect() from within onNewMove
        if (it[PRE]) continue; // present at subscribe time -> never "new"
        const id = postIdOf(it);
        if (!id || known.has(id)) continue;
        const text = postTextOf(it);
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

  Gage.transports.bluesky = {
    readThreadMoves,
    postReply,
    observe,
    getMyHandle,
    getRootAuthorHandle,
    SELECTORS: SEL,
    AUTO_SEND,
  };
})();
