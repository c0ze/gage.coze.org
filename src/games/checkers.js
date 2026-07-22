// Checkers (English draughts / American checkers) as a Game module. PURE and
// self-contained: no DOM, no libraries, no network. Both the desktop extension
// and the future mobile PWA reuse this untouched. Mirrors the chess module's
// shape (see src/games/chess.js for the full GAME MODULE INTERFACE contract).
//
// ============================================================================
// RULES (standard American checkers)
// ----------------------------------------------------------------------------
// * 8x8 board; play happens ONLY on the dark squares where (row+col)%2===1.
// * White ("w") starts on the dark squares of rows 5,6,7 (bottom); black ("b")
//   on the dark squares of rows 0,1,2 (top). WHITE MOVES FIRST (Gage's
//   white=challenger convention).
// * MEN move one step diagonally FORWARD to an empty dark square. Forward for
//   white = decreasing row (toward row 0); for black = increasing row (toward
//   row 7).
// * CAPTURE (jump): jump diagonally over an ADJACENT opponent piece into the
//   empty square immediately beyond, on the same diagonal. Men jump forward
//   only; KINGS move and jump in all four diagonal directions.
// * FORCED CAPTURE: if any capture is available to the side to move, every
//   non-capturing move is illegal. Any available capture is legal (we do NOT
//   enforce "capture the maximum").
// * MULTI-JUMP: after a jump, if the SAME piece can jump again it MUST continue;
//   the whole chain is ONE move.
// * KINGING: a man that ENDS its move on the far row (white -> row 0, black ->
//   row 7) becomes a king. If a man reaches the king row mid-chain BY A JUMP it
//   is crowned and the move ENDS immediately (no jump from the just-crowned
//   square).
// * TERMINAL: the side to move LOSES if it has no piece or no legal move.
//   result = the OTHER color. Draws in checkers are by agreement, so there is
//   no automatic draw detection here (documented, intentional).
//
// STATE SHAPE: { game: "checkers", moves: string[] } — the MOVE TEXT list in
// play order (e.g. "b6-a5", "c3xe5xg7"). We store move TEXT (not a board) so
// applyMove and applyMoveText share ONE reconstruction path and always produce
// byte-identical State for the same move. The board is derived by replaying the
// list from the fixed start position, so reconstruction is deterministic.
//
// NOTATION: a simple move is "from-to" (e.g. "b6-a5"); a jump (single or multi)
// lists the LANDING squares separated by "x" (e.g. "b6xd4" or "b6xd4xf2").
// ============================================================================
(function () {
  const Gage = (window.Gage = window.Gage || {});
  Gage.games = Gage.games || {};

  const ID = "checkers";
  const FILES = "abcdefgh";
  // Man = filled disc, king = star; both colors share the glyph and the
  // renderer tints by Cell.color (w/b). No tint.
  const MAN = "●";
  const KING = "★";

  // row 0 = top (black's home rows), col 0 = file a. a8 is top-left, matching
  // chess. Pieces live only where (row+col) is odd (the dark squares).
  const squareAt = (row, col) => FILES[col] + (8 - row);

  // Parse an algebraic square ("a8") back to { row, col }, or null if malformed.
  function parseSq(sq) {
    if (typeof sq !== "string" || sq.length !== 2) return null;
    const col = FILES.indexOf(sq[0]);
    const rank = sq.charCodeAt(1) - 48; // '1'..'8'
    if (col < 0 || rank < 1 || rank > 8) return null;
    return { row: 8 - rank, col };
  }

  const inBounds = (row, col) => row >= 0 && row < 8 && col >= 0 && col < 8;
  const isDark = (row, col) => (row + col) % 2 === 1;

  // ---- board model --------------------------------------------------------
  // A board is an 8x8 array of piece objects or null. A piece is
  // { color: "w"|"b", king: boolean }. Only dark squares are ever occupied.

  function startBoard() {
    const b = [];
    for (let r = 0; r < 8; r++) {
      const row = [];
      for (let c = 0; c < 8; c++) {
        let piece = null;
        if (isDark(r, c)) {
          if (r <= 2) piece = { color: "b", king: false }; // rows 0,1,2 = black
          else if (r >= 5) piece = { color: "w", king: false }; // rows 5,6,7 = white
        }
        row.push(piece);
      }
      b.push(row);
    }
    return b;
  }

  const clone = (b) => b.map((row) => row.map((p) => (p ? { color: p.color, king: p.king } : null)));
  const other = (color) => (color === "w" ? "b" : "w");

  // Forward-only diagonal steps for a man of `color`; kings get all four.
  function directions(piece) {
    if (piece.king) {
      return [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    }
    // white forward = decreasing row; black forward = increasing row.
    return piece.color === "w" ? [[-1, -1], [-1, 1]] : [[1, -1], [1, 1]];
  }

  // The far row where a man of `color` is crowned.
  const kingRow = (color) => (color === "w" ? 0 : 7);

  // ---- move generation ----------------------------------------------------
  // A generated Move is { from, path, captures, kinged } where `path` is the
  // list of landing squares (row/col) AFTER `from`, `captures` the jumped
  // pieces (row/col), and `kinged` whether the mover ends as a king. `text`
  // is the notation token. Simple (non-capturing) moves have a 1-length path
  // and no captures.

  // All jump chains starting from (r,c) for the piece currently there, on a
  // given board. Recursive: standard multi-jump with mandatory continuation and
  // the "crowned mid-chain ends the move" rule.
  function jumpsFrom(board, r, c) {
    const piece = board[r][c];
    if (!piece) return [];
    const results = [];

    // Depth-first over jump continuations. `curBoard` reflects captures so far
    // (jumped pieces removed, mover relocated) so a piece can't be jumped twice
    // and the landing squares are validated as empty.
    function walk(curBoard, cr, cc, curPiece, pathSqs, capSqs) {
      const dirs = directions(curPiece);
      let extended = false;
      for (const [dr, dc] of dirs) {
        const mr = cr + dr, mc = cc + dc; // jumped square
        const lr = cr + 2 * dr, lc = cc + 2 * dc; // landing square
        if (!inBounds(lr, lc)) continue;
        const mid = curBoard[mr][mc];
        if (!mid || mid.color === curPiece.color) continue; // must jump an enemy
        if (curBoard[lr][lc]) continue; // landing must be empty
        // Don't re-capture the same square within this chain.
        if (capSqs.some((s) => s.row === mr && s.col === mc)) continue;

        // Would this landing crown a man? If so the move ENDS here (no further
        // jump), per standard American rules.
        const crownsNow = !curPiece.king && lr === kingRow(curPiece.color);

        const nextBoard = clone(curBoard);
        nextBoard[cr][cc] = null;
        nextBoard[mr][mc] = null;
        const landedPiece = { color: curPiece.color, king: curPiece.king || crownsNow };
        nextBoard[lr][lc] = landedPiece;

        const nextPath = pathSqs.concat([{ row: lr, col: lc }]);
        const nextCaps = capSqs.concat([{ row: mr, col: mc }]);

        extended = true;
        if (crownsNow) {
          // Crowned mid-chain: stop the chain here.
          results.push({ path: nextPath, captures: nextCaps, kinged: true });
        } else {
          const before = results.length;
          walk(nextBoard, lr, lc, landedPiece, nextPath, nextCaps);
          // If no further jump was possible, this landing is a terminal chain.
          if (results.length === before) {
            results.push({ path: nextPath, captures: nextCaps, kinged: landedPiece.king });
          }
        }
      }
      return extended;
    }

    walk(board, r, c, piece, [], []);
    return results.map((res) => ({
      from: { row: r, col: c },
      path: res.path,
      captures: res.captures,
      kinged: res.kinged,
    }));
  }

  // Simple (non-capturing) steps from (r,c).
  function stepsFrom(board, r, c) {
    const piece = board[r][c];
    if (!piece) return [];
    const out = [];
    for (const [dr, dc] of directions(piece)) {
      const nr = r + dr, nc = c + dc;
      if (!inBounds(nr, nc) || board[nr][nc]) continue;
      const kinged = !piece.king && nr === kingRow(piece.color);
      out.push({
        from: { row: r, col: c },
        path: [{ row: nr, col: nc }],
        captures: [],
        kinged,
      });
    }
    return out;
  }

  // Attach the notation token to a generated move.
  function withText(mv) {
    const from = squareAt(mv.from.row, mv.from.col);
    if (mv.captures.length) {
      const lands = mv.path.map((p) => squareAt(p.row, p.col));
      mv.text = from + "x" + lands.join("x");
    } else {
      mv.text = from + "-" + squareAt(mv.path[0].row, mv.path[0].col);
    }
    return mv;
  }

  // ALL legal moves for `color` on `board`, with the forced-capture rule
  // applied: if any capture exists, only captures are returned.
  function legalMoves(board, color) {
    const jumps = [];
    const steps = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (!p || p.color !== color) continue;
        for (const j of jumpsFrom(board, r, c)) jumps.push(withText(j));
        for (const s of stepsFrom(board, r, c)) steps.push(withText(s));
      }
    }
    return jumps.length ? jumps : steps;
  }

  // Apply a generated move to a board, returning a NEW board. Mirrors the
  // capture/relocation/crowning the generator already validated.
  function applyToBoard(board, mv) {
    const b = clone(board);
    const src = b[mv.from.row][mv.from.col];
    b[mv.from.row][mv.from.col] = null;
    for (const cap of mv.captures) b[cap.row][cap.col] = null;
    const dest = mv.path[mv.path.length - 1];
    b[dest.row][dest.col] = { color: src.color, king: src.king || mv.kinged };
    return b;
  }

  // ---- reconstruction -----------------------------------------------------
  // Replay a State's move-text list from the start position. Returns
  // { board, turn, ok } where turn = the side to move AFTER the replayed moves
  // and `ok` is false if any stored token failed to resolve (a corrupt/tampered
  // history). Callers MUST honor `ok`: a corrupt history is not a valid position
  // and must not be silently reinterpreted as a fresh game (which would let new
  // moves apply against the start board while the bogus tokens survive in the
  // stored list). Trusts stored moves (they were legal when recorded); still
  // resolves each token against the legal set so board + crownings stay exact.
  function replay(state) {
    let board = startBoard();
    let color = "w"; // white moves first
    const moves = (state && state.moves) || [];
    for (const text of moves) {
      const mv = findMove(board, color, text);
      if (!mv) return { board, turn: color, ok: false }; // corrupt history
      board = applyToBoard(board, mv);
      color = other(color);
    }
    return { board, turn: color, ok: true };
  }

  // Resolve a notation token to a legal Move for `color` on `board`, or null.
  function findMove(board, color, text) {
    if (typeof text !== "string") return null;
    const token = text.trim();
    if (!token) return null;
    const moves = legalMoves(board, color);
    for (const mv of moves) if (mv.text === token) return mv;
    return null;
  }

  // ---- interface ----------------------------------------------------------

  function initialState() {
    return { game: ID, moves: [] };
  }

  function view(state) {
    const { board } = replay(state); // renders the position up to the divergence
    const rows = [];
    for (let r = 0; r < 8; r++) {
      const row = [];
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        row.push(p ? { glyph: p.king ? KING : MAN, color: p.color } : {});
      }
      rows.push(row);
    }
    return rows;
  }

  function turn(state) {
    return replay(state).turn;
  }

  // Legal destination squares for the piece on `sq`. For a two-click movement
  // game the "destination" is the FINAL landing square of a move; multi-jumps
  // therefore surface their last landing here. [] if it's not your piece, the
  // square is empty, a capture is forced elsewhere, or the game is over.
  function legalMovesFrom(state, sq) {
    if (terminal(state).over) return [];
    const from = parseSq(sq);
    if (!from) return [];
    const { board, turn: color, ok } = replay(state);
    if (!ok) return []; // corrupt history: no move is offered
    const p = board[from.row][from.col];
    if (!p || p.color !== color) return [];
    const moves = legalMoves(board, color).filter(
      (mv) => mv.from.row === from.row && mv.from.col === from.col
    );
    const seen = new Set();
    const out = [];
    for (const mv of moves) {
      const dest = mv.path[mv.path.length - 1];
      const s = squareAt(dest.row, dest.col);
      if (!seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  }

  // Resolve a from/to click pair to the single legal move it denotes. `to` is
  // the FINAL landing square. Two distinct jump chains can share the SAME from
  // AND the same final landing while capturing different pieces (e.g. a king
  // circling a ring of enemies clockwise vs. counter-clockwise, both ending on
  // its start square). To keep click and text equivalent, callers may pass the
  // complete landing path via `opts.path` (the ordered list of landing squares
  // AFTER `from`, e.g. ["c5","a3","c1"]); it uniquely selects the chain. Without
  // it we fall back to the first chain matching from/to — correct whenever the
  // endpoint is unambiguous, and the only reachable behavior for the current UI,
  // which supplies just from/to.
  function resolveMove(state, from, to, opts) {
    if (terminal(state).over) return null;
    const f = parseSq(from), t = parseSq(to);
    if (!f || !t) return null;
    const { board, turn: color, ok } = replay(state);
    if (!ok) return null; // corrupt history: refuse to apply against a bogus base
    const p = board[f.row][f.col];
    if (!p || p.color !== color) return null;

    // Optional full-path disambiguation: match the entire ordered landing list.
    const wantPath =
      opts && Array.isArray(opts.path) && opts.path.length
        ? opts.path.map((s) => parseSq(s))
        : null;
    if (wantPath && wantPath.some((s) => !s)) return null; // malformed path

    const moves = legalMoves(board, color);
    for (const mv of moves) {
      if (mv.from.row !== f.row || mv.from.col !== f.col) continue;
      const dest = mv.path[mv.path.length - 1];
      if (dest.row !== t.row || dest.col !== t.col) continue;
      if (wantPath) {
        if (mv.path.length !== wantPath.length) continue;
        const matches = mv.path.every(
          (p2, i) => p2.row === wantPath[i].row && p2.col === wantPath[i].col
        );
        if (!matches) continue;
      }
      return mv;
    }
    return null;
  }

  // Returns the NEXT state (new object; does not mutate `state`) or null if the
  // move is illegal. Returns null once terminal — enforced here, not just in the
  // renderer, since the module is the source of truth for every client.
  // `opts.path` (optional) disambiguates chains that share from/to; see
  // resolveMove.
  function applyMove(state, from, to, opts) {
    const mv = resolveMove(state, from, to, opts);
    if (!mv) return null;
    return { game: ID, moves: ((state && state.moves) || []).concat([mv.text]) };
  }

  // Human label for the from->to move, computed against `state` (the position
  // BEFORE the move): "b6-a5" for a step, "b6xd4xf2" for a jump chain.
  // `opts.path` (optional) disambiguates chains that share from/to.
  function moveText(state, from, to, opts) {
    const mv = resolveMove(state, from, to, opts);
    return mv ? mv.text : "";
  }

  // Inverse of moveText and the transport entry point: apply a notation token
  // and return the NEXT state, or null if unparseable/illegal in `state`
  // (including a non-capture when a capture is forced, or an incomplete
  // multi-jump when continuation is mandatory — those tokens simply won't match
  // any member of the legal set, since the generator only emits COMPLETE
  // chains). Produces State byte-identical to the applyMove path for the same
  // move, since both append the same canonical token.
  function applyMoveText(state, text) {
    if (typeof text !== "string" || !text.trim()) return null;
    if (terminal(state).over) return null;
    const { board, turn: color, ok } = replay(state);
    if (!ok) return null; // corrupt history: refuse to extend a bogus base
    const mv = findMove(board, color, text.trim());
    if (!mv) return null;
    return { game: ID, moves: ((state && state.moves) || []).concat([mv.text]) };
  }

  function terminal(state) {
    const { board, turn: color, ok } = replay(state);
    // A corrupt/tampered history is not a valid position: report it as not-over
    // with no winner, and let the apply paths (which also check `ok`) reject any
    // move against it. We do NOT invent a result from the partial board.
    if (!ok) return { over: false, corrupt: true };
    // The side to move loses if it has no piece or no legal move.
    if (legalMoves(board, color).length === 0) {
      return { over: true, result: other(color) };
    }
    return { over: false };
  }

  // True if from->to is a capture (jump). Lets the renderer flag jumps whose
  // intermediate squares clear, not just the destination.
  function isCapture(state, from, to, opts) {
    const mv = resolveMove(state, from, to, opts);
    return !!(mv && mv.captures.length);
  }

  // positionKey(state) -> string  (the CONTRACT image cache-key)
  // The VISUAL position only: one char per DARK square (32 total), scanned in
  // row-major order (row 0..7, col 0..7, dark squares only). Encoding:
  //   "-" empty, "w" white man, "W" white king, "b" black man, "B" black king.
  // Side-to-move and history are intentionally excluded, so equal boards share
  // ONE key (and one cached image). URL-safe ASCII, 32 chars (< 115).
  function positionKey(state) {
    const { board } = replay(state);
    let key = "";
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (!isDark(r, c)) continue;
        const p = board[r][c];
        if (!p) key += "-";
        else if (p.color === "w") key += p.king ? "W" : "w";
        else key += p.king ? "B" : "b";
      }
    }
    return key;
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
    positionKey,
  };
})();
