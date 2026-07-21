// Chess as the first Game module. Backed by vendored chess.js (window.Chess).
// PURE / PORTABLE: no DOM, no extension APIs, no Twitter/X APIs. Both the
// desktop extension and the future mobile PWA reuse this untouched.
//
// ============================================================================
// GAME MODULE INTERFACE  (every grid game on this platform implements this)
// ----------------------------------------------------------------------------
// A Game module is a plain object registered at window.Gage.games[id]. Squares
// are algebraic strings ("e2"); this convention is used everywhere (views,
// legalMovesFrom, applyMove, moveText). Rows/cols are 0-indexed with row 0 at
// the TOP of view(state) (chess: rank 8), col 0 at the LEFT (chess: file a).
//
//   id            : string                      unique game id, e.g. "chess"
//   boardSize     : { rows: number, cols: number }
//
//   initialState()            -> State
//       Fresh game. State is a plain, JSON-serializable object and MUST carry
//       its own game id (State.game === id) so a seed is self-describing.
//
//   view(state)               -> Cell[][]       rows x cols, row 0 at top
//       Cell = { glyph?: string, color?: "w"|"b", tint?: string }
//
//   turn(state)               -> "w" | "b"      side to move
//
//   legalMovesFrom(state, sq) -> Square[]        legal destination squares for
//       the piece on `sq`. [] if none / not your turn / empty square.
//
//   applyMove(state, from, to, opts?) -> State | null
//       Returns the NEXT state (new object; does not mutate `state`) or
//       null/undefined if illegal. `opts` game-specific (chess: { promotion }).
//
//   moveText(state, from, to) -> string          human label (chess: SAN "Nf3"),
//       computed against `state` (the position BEFORE the move).
//
//   applyMoveText(state, text) -> State | null    OPTIONAL. Inverse of moveText:
//       apply a human move token (chess: SAN "Nf3") and return the NEXT state, or
//       null if the text is unparseable/illegal in `state`. This is the transport
//       entry point — the thread carries move TEXT, not from/to — and MUST produce
//       a State identical to the from/to path (applyMove) for the same move, so a
//       game rebuilt from a reply chain equals one built by clicking.
//
//   terminal(state)           -> { over: boolean, result?: "w"|"b"|"draw" }
//
//   squareAt(row, col)        -> Square           OPTIONAL. Maps a view cell to
//       its square string; else the renderer falls back to `col + "," + row`.
//
//   isCapture(state, from, to) -> boolean         OPTIONAL. True if the move is a
//       capture. Lets the renderer flag captures whose destination looks empty
//       (en passant); without it the renderer falls back to "destination has a
//       glyph".
//
// STATE SHAPE (chess): { game: "chess", moves: Move[] } where
//   Move = { from, to, promotion? }. We store the MOVE LIST (not just a FEN) and
//   replay it into chess.js on demand, so position history is preserved — rules
//   that need it (threefold repetition) work. A bare FEN would lose that history.
// ============================================================================
(function () {
  const Gage = (window.Gage = window.Gage || {});
  Gage.games = Gage.games || {};

  const ID = "chess";
  // Unicode chess glyphs, keyed by lowercase piece type. Both colors share the
  // solid glyph; the renderer tints by Cell.color (w/b).
  const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
  const FILES = "abcdefgh";

  // row 0 = rank 8 (top), col 0 = file a. Mirrors chess.js board() indexing.
  const squareAt = (row, col) => FILES[col] + (8 - row);

  // Rebuild a chess.js engine for `state` by replaying its move list from the
  // start position. Replaying (vs. loading a FEN) preserves the repetition
  // history chess.js needs for threefold / draw detection. Throws if the
  // vendored library is missing.
  function engine(state) {
    if (typeof window.Chess !== "function") {
      throw new Error("[gage] vendored chess.js (window.Chess) not loaded");
    }
    const c = new window.Chess();
    const moves = (state && state.moves) || [];
    for (const m of moves) c.move(m);
    return c;
  }

  // ---- interface ----------------------------------------------------------

  function initialState() {
    return { game: ID, moves: [] };
  }

  function view(state) {
    // chess.js board(): 8x8, [0][0] = a8 (top-left). Matches our convention.
    const b = engine(state).board();
    const rows = [];
    for (let r = 0; r < 8; r++) {
      const row = [];
      for (let col = 0; col < 8; col++) {
        const piece = b[r][col];
        row.push(piece ? { glyph: GLYPH[piece.type], color: piece.color } : {});
      }
      rows.push(row);
    }
    return rows;
  }

  function turn(state) {
    return engine(state).turn();
  }

  function legalMovesFrom(state, sq) {
    let moves;
    try {
      // verbose:true for destination squares; chess.js already filters to the
      // side to move and excludes moves that leave the king in check.
      moves = engine(state).moves({ square: sq, verbose: true });
    } catch (e) {
      return []; // invalid square string, etc.
    }
    // Dedupe destinations (promotions yield 4 moves to the same square).
    const seen = new Set();
    const out = [];
    for (const m of moves) {
      if (!seen.has(m.to)) {
        seen.add(m.to);
        out.push(m.to);
      }
    }
    return out;
  }

  function applyMove(state, from, to, opts) {
    const c = engine(state);
    // The game module is the source of truth for every client (extension, PWA)
    // and the transport layer, so enforce "no moves after game over" here — not
    // only in the renderer. chess.js still generates legal moves after draws by
    // rule (threefold, 50-move, insufficient material), so guard explicitly.
    if (c.isGameOver()) return null;
    const promotion = (opts && opts.promotion) || "q";
    let mv;
    try {
      mv = c.move({ from, to, promotion });
    } catch (e) {
      return null; // chess.js throws on illegal moves
    }
    if (!mv) return null;
    const move = { from, to };
    if (mv.promotion) move.promotion = mv.promotion; // only record real promotions
    return { game: ID, moves: ((state && state.moves) || []).concat([move]) };
  }

  function moveText(state, from, to) {
    try {
      const mv = engine(state).move({ from, to, promotion: "q" });
      return mv ? mv.san : "";
    } catch (e) {
      return "";
    }
  }

  // Inverse of moveText: apply a SAN token (e.g. "Nf3", "exd6", "O-O", "e8=Q")
  // and return the next State, or null if unparseable/illegal in `state`. This is
  // how the transport replays a thread (which carries move TEXT, not from/to).
  // chess.js parses SAN natively and throws on illegal input. We record the SAME
  // { from, to, promotion? } shape as applyMove — read off chess.js's returned
  // move object — so a State rebuilt via applyMoveText is byte-identical to one
  // built via applyMove for the same move sequence.
  function applyMoveText(state, text) {
    if (typeof text !== "string" || !text.trim()) return null;
    const c = engine(state);
    // Same "no moves after game over" guard as applyMove: chess.js still
    // generates legal moves after draws by rule, so enforce termination here.
    if (c.isGameOver()) return null;
    let mv;
    try {
      mv = c.move(text.trim());
    } catch (e) {
      return null; // chess.js throws on illegal / unparseable SAN
    }
    if (!mv) return null;
    const move = { from: mv.from, to: mv.to };
    if (mv.promotion) move.promotion = mv.promotion; // only record real promotions
    return { game: ID, moves: ((state && state.moves) || []).concat([move]) };
  }

  function terminal(state) {
    const c = engine(state);
    if (!c.isGameOver()) return { over: false };
    if (c.isCheckmate()) {
      // Side to move is checkmated -> the OTHER side won.
      return { over: true, result: c.turn() === "w" ? "b" : "w" };
    }
    // Stalemate, insufficient material, threefold, 50-move -> draw.
    return { over: true, result: "draw" };
  }

  // True if from->to is a capture, including en passant (flag "e"), whose
  // destination square is empty pre-move so the renderer can't infer it.
  function isCapture(state, from, to) {
    let moves;
    try {
      moves = engine(state).moves({ square: from, verbose: true });
    } catch (e) {
      return false;
    }
    return moves.some(
      (m) => m.to === to && (m.flags.indexOf("c") !== -1 || m.flags.indexOf("e") !== -1)
    );
  }

  Gage.games[ID] = {
    id: ID,
    boardSize: { rows: 8, cols: 8 },
    initialState,
    view,
    turn,
    legalMovesFrom,
    applyMove,
    moveText,
    applyMoveText,
    terminal,
    squareAt,
    isCapture,
  };
})();
