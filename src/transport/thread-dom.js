// DOM-coupled transport for X (Twitter). window.Gage.threadTransport.
//
// This is the ONLY Gage file that touches the live X page. Everything below is
// STUBBED because this dev environment has no X: each method returns a safe
// default and console.warn()s that it is unwired. Pairs with the pure layers:
//   protocol.js    parses/builds tweet text (formatMove / parseMove)
//   reconstruct.js replays parsed move texts into a State
// This layer's whole job is (a) pull ordered tweet TEXTS out of the DOM and
// (b) push a reply into the composer. It parses/replays NOTHING itself.
//
// ============================================================================
// LIVE-X WIRING CHECKLIST  — a follow-up session must fill in EXACTLY these.
// X ships no stable API here; selectors are DOM-reverse-engineered and rot, so
// each is called out with what it must resolve to. (Current as an inventory of
// intent, not verified selectors — verify against the live DOM when wiring.)
//
//  [1] CONVERSATION CONTAINER  (for readThreadMoves + observe root)
//      The scroll region holding the thread's tweets in order. Today X marks
//      cells with:  article[data-testid="tweet"]  living under a timeline
//      section (e.g. [aria-label*="Timeline"] / [role="region"]). Need: the
//      nearest stable ancestor of the tweet articles to scope queries + observe.
//
//  [2] TWEET / ARTICLE NODES  (ordered move source for readThreadMoves)
//      Each tweet:  article[data-testid="tweet"].
//      Text body:   [data-testid="tweetText"]  (concatenate its text nodes;
//      emoji are <img alt="♟">, so read alt text too). DOM order == thread
//      order top-down (root first) — do NOT re-sort by timestamp (equal-second
//      replies would scramble). Return each tweet's RAW text in that order; the
//      caller (content.js) parses via Gage.protocol.parseMove and drops non-moves.
//
//  [3] TWEET PERMALINK / ID  (identity + reply targeting)
//      Status id lives in the permalink:  a[href*="/status/"] time  ->
//      closest("a").href matches m|/status/(\d+)|. Need it to (a) know the
//      LATEST tweet in the thread (reply target) and (b) dedupe in observe().
//
//  [4] REPLY COMPOSER — EDITABLE ELEMENT  (for postReply)
//      X uses a DraftJS contentEditable, not a <textarea>:
//        div[data-testid="tweetTextarea_0"]  (role="textbox", contenteditable).
//      Setting .value does nothing. To prefill: focus it, then insert text via
//      the clipboard paste path or document.execCommand("insertText", ...), or
//      dispatch a beforeinput/input InputEvent with inputType "insertText" so
//      DraftJS updates its model. Confirm the composer is the INLINE reply box
//      under the target tweet (open it by clicking [data-testid="reply"]).
//
//  [5] SEND / REPLY BUTTON  (submit in postReply)
//      Inline reply button:  [data-testid="tweetButtonInline"]
//      Modal composer button: [data-testid="tweetButton"]
//      Both go disabled (aria-disabled="true") until the editor has text — so
//      prefill [4] first, then wait for enabled, then click. Keyboard fallback:
//      Ctrl/Cmd+Enter while the editor is focused.
//
//  [6] REPLY-TO WIRING  (make postReply reply to the LATEST tweet, not a new top-level tweet)
//      Click the target tweet's [data-testid="reply"] to open the inline
//      composer scoped to it (uses [3] to pick the latest). Alternative:
//      navigate to the compose intent for that status id. Ensure the opened
//      composer is the one queried in [4]/[5].
//
//  [7] NOTIFICATION / NEW-REPLY HOOK  (for observe)
//      A MutationObserver on [1] watching childList for added
//      article[data-testid="tweet"] nodes; for each added node, parse via
//      Gage.protocol.parseMove, dedupe by status id [3], and if it's a new move
//      call onNewMove(moveText). (Optional richer source: the notifications tab
//      / a title "(1) ..." change — but the in-thread observer is enough.)
// ============================================================================
(function () {
  const Gage = (window.Gage = window.Gage || {});

  const UNWIRED = "[gage] threadTransport is unwired (no live X here): ";

  // readThreadMoves() -> string[]
  // Ordered tweet texts of the current conversation, top-down (root first). The
  // caller runs each through Gage.protocol.parseMove and Gage.reconstruct.
  // STUB: returns []. Wire per checklist [1][2][3].
  function readThreadMoves() {
    console.warn(UNWIRED + "readThreadMoves() -> [] (see checklist [1][2][3])");
    return [];
  }

  // postReply(text) -> void
  // Prefill X's inline reply composer (replying to the LATEST tweet in the
  // thread) with `text` and submit. `text` comes from Gage.protocol.formatMove.
  // STUB: no-op. Wire per checklist [4][5][6].
  function postReply(text) {
    // String() (not JSON.stringify) so this stub can never throw on odd inputs.
    console.warn(
      UNWIRED + "postReply() dropped (see checklist [4][5][6]); text was: " +
        String(text)
    );
  }

  // observe(onNewMove) -> void
  // Watch the conversation for incoming replies; call onNewMove(moveText) for
  // each new, deduped move tweet. STUB: no-op. Wire per checklist [7].
  function observe(onNewMove) {
    console.warn(UNWIRED + "observe() is inert (see checklist [7])");
    // no observer attached; onNewMove will never fire in this stub.
    void onNewMove;
  }

  Gage.threadTransport = {
    readThreadMoves,
    postReply,
    observe,
  };
})();
