// Reversi (Othello) as a PLACEMENT game module. PURE / PORTABLE: no DOM, no
// external libraries, no network — the same object serves the desktop extension
// and the future mobile PWA untouched. See src/games/chess.js for the full
// GAME MODULE INTERFACE contract; this file adds the PLACEMENT-GAME extensions.
//
// ============================================================================
// PLACEMENT-GAME CONVENTION  (reversi + gomoku; contrast chess/checkers which
// are two-click MOVEMENT games)
// ----------------------------------------------------------------------------
// A placement module is played with a SINGLE click on an empty square, so it
// sets moveKind:"place" and adds:
//
//   legalMoves(state)          -> Square[]   ALL squares the side to move may
//       place on (reversi: every empty square that flips >= 1 disc).
//
//   mustPass(state)            -> boolean     true iff the side to move has no
//       legal placement AND the game is not over (the opponent still has a
//       move) — so the only legal action is to PASS. Gomoku never passes.
//
// A placement "move" is applyMove(state, sq, sq) with from === to === sq.
// moveText(state, sq, sq) is the square token ("d3"); applyMoveText(state, tok)
// places at that square. The PASS token is the literal string "pass":
// applyMoveText(state, "pass") flips the turn and leaves the board unchanged.
// legalMovesFrom(state, sq) returns [sq] when placing at sq is legal, else [].
//
// STATE SHAPE: { game: "reversi", moves: string[] } — the ordered list of move
// tokens ("d3", "c4", "pass", ...). We store the token list (not a packed
// board) and replay it deterministically, mirroring chess.js's move-list
// approach so a State rebuilt from a reply chain equals one built by clicking.
// ============================================================================
(function () {
  const Gage = (window.Gage = window.Gage || {});
  Gage.games = Gage.games || {};

  const ID = "reversi";
  const SIZE = 8;
  const FILES = "abcdefgh";
  // Solid disc; the renderer tints by Cell.color (w/b). Both colors share it.
  const DISC = "●";

  // The eight straight-line directions (row delta, col delta) a flank may run.
  const DIRS = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1],           [0, 1],
    [1, -1],  [1, 0],  [1, 1],
  ];

  // row 0 = rank 8 (top), col 0 = file a. squareAt("d",4) style algebraic.
  const squareAt = (row, col) => FILES[col] + (SIZE - row);

  // Parse an algebraic square ("d3") to { row, col } in view coordinates, or
  // null if malformed / off-board. Inverse of squareAt.
  function parseSquare(sq) {
    if (typeof sq !== "string" || sq.length !== 2) return null;
    const col = FILES.indexOf(sq[0]);
    const rank = Number(sq[1]);
    if (col === -1 || !Number.isInteger(rank) || rank < 1 || rank > SIZE) return null;
    return { row: SIZE - rank, col };
  }

  const inBounds = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;
  const other = (color) => (color === "w" ? "b" : "w");

  // Fresh 8x8 board as a row-major array of "" | "w" | "b". The four centre
  // squares start filled: d4 & e5 = white, d5 & e4 = black.
  function freshBoard() {
    const b = [];
    for (let r = 0; r < SIZE; r++) b.push(new Array(SIZE).fill(""));
    // d4/e5 white, d5/e4 black (view rows: 8-rank).
    b[SIZE - 4][FILES.indexOf("d")] = "w"; // d4
    b[SIZE - 5][FILES.indexOf("e")] = "w"; // e5
    b[SIZE - 5][FILES.indexOf("d")] = "b"; // d5
    b[SIZE - 4][FILES.indexOf("e")] = "b"; // e4
    return b;
  }

  // Discs flipped by placing `color` at (row,col) on `board`. Returns the list
  // of [row,col] captured in every flanking direction (empty if the placement
  // is illegal — i.e. flips nothing). A direction contributes only when a
  // contiguous non-empty run of OPPONENT discs is terminated by one of OURS.
  function flips(board, row, col, color) {
    if (board[row][col] !== "") return []; // must be an empty square
    const opp = other(color);
    const out = [];
    for (const [dr, dc] of DIRS) {
      const run = [];
      let r = row + dr;
      let c = col + dc;
      while (inBounds(r, c) && board[r][c] === opp) {
        run.push([r, c]);
        r += dr;
        c += dc;
      }
      // Flanked only if the run is non-empty AND terminated by our own disc
      // (not the board edge, not an empty square).
      if (run.length && inBounds(r, c) && board[r][c] === color) {
        for (const cell of run) out.push(cell);
      }
    }
    return out;
  }

  // Replay a State's token list into { board, turn }. WHITE MOVES FIRST. Each
  // token is a square ("d3") — placed for the side to move, flipping every
  // flanked disc — or the literal "pass", which only flips the turn. Replaying
  // (vs. storing a packed board) keeps reconstruction deterministic and lets a
  // thread rebuilt from move TEXT match one built by clicking.
  function replay(state) {
    const board = freshBoard();
    let turn = "w"; // white = challenger, moves first
    const moves = (state && state.moves) || [];
    for (const tok of moves) {
      if (tok === "pass") {
        turn = other(turn);
        continue;
      }
      const sq = parseSquare(tok);
      if (!sq) continue; // ignore malformed tokens defensively
      const flipped = flips(board, sq.row, sq.col, turn);
      board[sq.row][sq.col] = turn;
      for (const [r, c] of flipped) board[r][c] = turn;
      turn = other(turn);
    }
    return { board, turn };
  }

  // Every legal placement square (as algebraic tokens) for `color` on `board`.
  function legalSquares(board, color) {
    const out = [];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (board[r][c] === "" && flips(board, r, c, color).length) {
          out.push(squareAt(r, c));
        }
      }
    }
    return out;
  }

  // Count discs of each color on the board.
  function counts(board) {
    let w = 0;
    let b = 0;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (board[r][c] === "w") w++;
        else if (board[r][c] === "b") b++;
      }
    }
    return { w, b };
  }

  // ---- interface ----------------------------------------------------------

  function initialState() {
    return { game: ID, moves: [] };
  }

  function view(state) {
    const board = replay(state).board;
    const rows = [];
    for (let r = 0; r < SIZE; r++) {
      const row = [];
      for (let c = 0; c < SIZE; c++) {
        const cell = board[r][c];
        row.push(cell ? { glyph: DISC, color: cell } : {});
      }
      rows.push(row);
    }
    return rows;
  }

  function turn(state) {
    return replay(state).turn;
  }

  // ALL legal placement squares for the side to move (placement convention).
  function legalMoves(state) {
    const { board, turn: t } = replay(state);
    if (terminal(state).over) return []; // no placements once terminal
    return legalSquares(board, t);
  }

  // [sq] when placing at sq is legal for the side to move, else []. Reuses
  // legalMoves so "legal from here" and "legal anywhere" can't drift apart.
  function legalMovesFrom(state, sq) {
    return legalMoves(state).indexOf(sq) !== -1 ? [sq] : [];
  }

  // true iff the side to move has no legal placement and the game is not over
  // (the opponent still has a move) — the only legal action is "pass".
  function mustPass(state) {
    if (terminal(state).over) return false;
    return legalMoves(state).length === 0;
  }

  // A placement move: from === to === sq. Returns a NEW State (never mutates)
  // or null if the placement is illegal / off-board / the game is over.
  function applyMove(state, from, to, opts) {
    // Enforce "no moves after game over" here — the module is the source of
    // truth for every client and the transport, not only the renderer.
    if (terminal(state).over) return null;
    if (from !== to) return null; // placement moves are single-square
    const parsed = parseSquare(to);
    if (!parsed) return null;
    const { board, turn: t } = replay(state);
    // Legal only if it flips >= 1 disc.
    if (!flips(board, parsed.row, parsed.col, t).length) return null;
    return { game: ID, moves: ((state && state.moves) || []).concat([to]) };
  }

  // moveText(state, sq, sq) -> the placed square token ("d3"), computed against
  // the position BEFORE the move (kept for signature parity with chess).
  function moveText(state, from, to) {
    return from === to && parseSquare(to) ? to : "";
  }

  // Inverse of moveText and the transport entry point. Places at `text` (or
  // passes on the literal "pass") and returns the next State, byte-identical to
  // the applyMove path for the same move, or null if illegal in `state`.
  function applyMoveText(state, text) {
    if (typeof text !== "string" || !text.trim()) return null;
    const tok = text.trim();
    if (terminal(state).over) return null; // no moves after game over
    if (tok === "pass") {
      // A pass is legal ONLY when the side to move genuinely has no placement.
      if (!mustPass(state)) return null;
      return { game: ID, moves: ((state && state.moves) || []).concat(["pass"]) };
    }
    // Otherwise it's a placement token; defer to applyMove for the flip rule.
    return applyMove(state, tok, tok);
  }

  // over when NEITHER side has a legal placement (typically a full board or a
  // mutual no-move). result = the color with MORE discs; equal counts = draw.
  function terminal(state) {
    const board = replay(state).board;
    const wCan = legalSquares(board, "w").length > 0;
    const bCan = legalSquares(board, "b").length > 0;
    if (wCan || bCan) return { over: false };
    const { w, b } = counts(board);
    if (w > b) return { over: true, result: "w" };
    if (b > w) return { over: true, result: "b" };
    return { over: true, result: "draw" };
  }

  // A placement always "captures" (flips) at least one disc — it's illegal
  // otherwise — so any legal, non-pass placement is a capture. Lets the
  // renderer flag the flips even though the destination was empty pre-move.
  function isCapture(state, from, to) {
    if (from !== to) return false;
    const parsed = parseSquare(to);
    if (!parsed) return false;
    const { board, turn: t } = replay(state);
    return flips(board, parsed.row, parsed.col, t).length > 0;
  }

  // positionKey(state) -> string  (the image cache-key)
  // The VISUAL position only: 8 rows of 8 cells encoded "." = empty,
  // "w"/"b" = disc, rows joined by "-". URL-safe ASCII (letters, digits, "-"),
  // ~71 chars. Side-to-move / history are intentionally dropped, so any two
  // States reaching the same board share ONE key (one cached image). E.g. the
  // start position (rank 5 = d5 black / e5 white; rank 4 = d4 white / e4 black):
  //   ........-........-........-...bw...-...wb...-........-........-........
  function positionKey(state) {
    const board = replay(state).board;
    const rows = [];
    for (let r = 0; r < SIZE; r++) {
      let s = "";
      for (let c = 0; c < SIZE; c++) s += board[r][c] === "" ? "." : board[r][c];
      rows.push(s);
    }
    return rows.join("-");
  }

  Gage.games[ID] = {
    id: ID,
    boardSize: { rows: SIZE, cols: SIZE },
    moveKind: "place",
    initialState,
    view,
    turn,
    legalMoves,
    legalMovesFrom,
    mustPass,
    applyMove,
    moveText,
    applyMoveText,
    terminal,
    squareAt,
    isCapture,
    positionKey,
  };
})();
