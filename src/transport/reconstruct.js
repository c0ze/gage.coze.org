// Rebuild game State by walking a reply chain. PURE / transport-independent.
//
// The thread IS the move list: given a Game module and the ordered move TEXTS
// parsed from a conversation's tweets (top-down: root challenge first, then each
// reply), replay them through the module to derive the current State. The first
// move that won't apply (unparseable or illegal in its position) stops the walk
// and is reported in `error` — that is the desync / cheat-detection signal.
//
//   Gage.reconstruct(gameModule, moveTexts) -> { state, moveCount, error }
//     gameModule : a Game module implementing initialState() + applyMoveText()
//     moveTexts  : string[]  human move tokens, in play order (e.g. SAN)
//
//     state      : the State after applying every ACCEPTED move (on failure,
//                  the last good State — the position just before the bad move)
//     moveCount  : number of moves successfully applied
//     error      : null on full success; else
//                  { index, moveText, reason } for the first move that failed
//                  (index is 0-based into moveTexts)
(function () {
  const Gage = (window.Gage = window.Gage || {});

  function reconstruct(gameModule, moveTexts) {
    if (!gameModule || typeof gameModule.initialState !== "function") {
      return {
        state: null,
        moveCount: 0,
        error: { index: -1, moveText: null, reason: "invalid game module" },
      };
    }
    if (typeof gameModule.applyMoveText !== "function") {
      return {
        state: gameModule.initialState(),
        moveCount: 0,
        error: {
          index: -1,
          moveText: null,
          reason: "game module does not implement applyMoveText",
        },
      };
    }

    const texts = Array.isArray(moveTexts) ? moveTexts : [];
    let state = gameModule.initialState();
    let moveCount = 0;

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      // Skip non-move entries (null/blank thread chatter). Only a real, non-empty
      // move token that won't apply is a desync/cheat that stops the walk.
      if (text == null || String(text).trim() === "") continue;
      const next = gameModule.applyMoveText(state, text);
      if (!next) {
        // First move that won't apply: stop and report it. `state` stays at the
        // last legal position so callers can still render the board up to here.
        return {
          state,
          moveCount,
          error: {
            index: i,
            moveText: text,
            reason: "illegal or unparseable move",
          },
        };
      }
      state = next;
      moveCount++;
    }

    return { state, moveCount, error: null };
  }

  Gage.reconstruct = reconstruct;
})();
