// Gomoku (Five in a Row / Gobang, freestyle) as a Game module. PURE / PORTABLE:
// no DOM, no external libraries, no network. Both the desktop extension and the
// future mobile PWA reuse this untouched.
//
// ============================================================================
// GAME MODULE INTERFACE  (see src/games/chess.js for the full contract)
// ----------------------------------------------------------------------------
// Gomoku is a PLACEMENT game (single-click), NOT a movement game like chess. It
// therefore also exposes the placement convention on top of the base interface:
//
//   moveKind : "place"                            the renderer/content.js branch
//   legalMoves(state)         -> Square[]          ALL legal placement squares
//   mustPass(state)           -> boolean           gomoku NEVER passes (always false)
//
// A placement "move" is applyMove(state, sq, sq) with from === to === sq. Its
// moveText is just the square token ("h8"); applyMoveText places at that square.
// legalMovesFrom(state, sq) returns [sq] if placing at sq is legal, else [].
//
// BOARD: 15x15 intersections. squareAt(row,col) = file a..o (col) + rank 15..1,
// so a15 is the TOP-LEFT view cell and o1 is the BOTTOM-RIGHT. WHITE MOVES FIRST
// (Gage convention). A stone may be placed on ANY empty intersection.
//
// WIN: as soon as the side that just moved has FIVE OR MORE of its stones in a
// contiguous line (horizontal, vertical, or either diagonal) that side wins —
// freestyle, so overlines of 6+ also win. DRAW: a full board (225 stones) with
// no five. Once terminal, applyMove/applyMoveText return null.
//
// STATE SHAPE: { game: "gomoku", moves: string[] } — the MOVE LIST of square
// tokens in play order, e.g. ["h8","h9",...]. White plays the even indices
// (0,2,...), Black the odd ones. Replaying the list is deterministic, so the
// board reconstructs identically whether it was built by clicking (applyMove) or
// from a reply chain (applyMoveText).
// ============================================================================
(function () {
  const Gage = (window.Gage = window.Gage || {});
  Gage.games = Gage.games || {};

  const ID = "gomoku";
  const N = 15; // 15x15 board
  const FILES = "abcdefghijklmno"; // 15 files a..o
  // Single stone glyph; the renderer tints by Cell.color (w/b).
  const STONE = "●";

  // row 0 = rank 15 (top), col 0 = file a (left). a15 is the top-left cell.
  const squareAt = (row, col) => FILES[col] + (N - row);

  // Parse a square token ("h8") -> { row, col } in view coordinates, or null if
  // it is not a well-formed on-board intersection.
  function parseSquare(sq) {
    if (typeof sq !== "string") return null;
    const col = FILES.indexOf(sq[0]);
    if (col === -1) return null;
    const rank = parseInt(sq.slice(1), 10);
    if (!Number.isInteger(rank) || rank < 1 || rank > N) return null;
    // Reject non-canonical tokens like "h08" (leading zero) so token<->square is
    // a strict bijection and positionKey/parse round-trips stay clean.
    if (sq.slice(1) !== String(rank)) return null;
    return { row: N - rank, col };
  }

  // Replay a state's move list into a fresh board: a 15x15 grid of 0 (empty),
  // "w", or "b". White plays even indices, Black odd. No legality checking here —
  // legality is enforced when moves are appended (applyMove / applyMoveText).
  function board(state) {
    const grid = [];
    for (let r = 0; r < N; r++) grid.push(new Array(N).fill(0));
    const moves = (state && state.moves) || [];
    for (let i = 0; i < moves.length; i++) {
      const p = parseSquare(moves[i]);
      if (!p) continue; // defensive; well-formed states never hit this
      grid[p.row][p.col] = i % 2 === 0 ? "w" : "b";
    }
    return grid;
  }

  // Four line directions (as row/col deltas): horizontal, vertical, and the two
  // diagonals. We scan both ways along each to count a contiguous run.
  const DIRS = [
    [0, 1], // horizontal
    [1, 0], // vertical
    [1, 1], // diagonal (top-left -> bottom-right)
    [1, -1], // anti-diagonal (top-right -> bottom-left)
  ];

  // True iff the stone of `color` at (row,col) is part of a run of >= 5 in any
  // direction. Freestyle: overlines (6+) count, so we never cap the run length.
  function fiveThrough(grid, row, col, color) {
    for (const [dr, dc] of DIRS) {
      let count = 1;
      // extend forward
      let r = row + dr;
      let c = col + dc;
      while (r >= 0 && r < N && c >= 0 && c < N && grid[r][c] === color) {
        count++;
        r += dr;
        c += dc;
      }
      // extend backward
      r = row - dr;
      c = col - dc;
      while (r >= 0 && r < N && c >= 0 && c < N && grid[r][c] === color) {
        count++;
        r -= dr;
        c -= dc;
      }
      if (count >= 5) return true;
    }
    return false;
  }

  // Scan the whole board for any five-in-a-row; return the winning color or null.
  // Used by terminal() to classify a reconstructed position (we only need to know
  // IF someone has five and WHO — the last mover, by construction).
  function winnerOnBoard(grid) {
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const color = grid[r][c];
        if (color && fiveThrough(grid, r, c, color)) return color;
      }
    }
    return null;
  }

  // ---- interface ----------------------------------------------------------

  function initialState() {
    return { game: ID, moves: [] };
  }

  function view(state) {
    const grid = board(state);
    const rows = [];
    for (let r = 0; r < N; r++) {
      const row = [];
      for (let c = 0; c < N; c++) {
        const color = grid[r][c];
        row.push(color ? { glyph: STONE, color } : {});
      }
      rows.push(row);
    }
    return rows;
  }

  // White plays even move indices, Black odd, so the side to move is determined
  // by the move count's parity.
  function turn(state) {
    const n = ((state && state.moves) || []).length;
    return n % 2 === 0 ? "w" : "b";
  }

  // ALL empty intersections are legal placements for the side to move (empty once
  // the game is over — no moves after termination). Order: row-major, top-left
  // first, so the list is deterministic.
  function legalMoves(state) {
    if (terminal(state).over) return [];
    const grid = board(state);
    const out = [];
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (!grid[r][c]) out.push(squareAt(r, c));
      }
    }
    return out;
  }

  // Placement form of legalMovesFrom: [sq] if placing at sq is legal for the side
  // to move, else []. (A single-click game asks "can I place here?" per cell.)
  function legalMovesFrom(state, sq) {
    if (terminal(state).over) return [];
    const p = parseSquare(sq);
    if (!p) return [];
    const grid = board(state);
    return grid[p.row][p.col] ? [] : [sq];
  }

  // Gomoku never passes: the side to move always has a legal placement while
  // the board has an empty cell, and a full board is terminal.
  function mustPass() {
    return false;
  }

  // Place a stone at `sq` (a placement move: from === to === sq). Returns the
  // NEXT state (new object; does not mutate `state`) or null if illegal. Enforces
  // "no moves after game over" here — the module is the source of truth for every
  // client and the transport, not only the renderer.
  function applyMove(state, from, to) {
    if (terminal(state).over) return null;
    if (from !== to) return null; // placement moves are single-cell
    const p = parseSquare(to);
    if (!p) return null;
    const grid = board(state);
    if (grid[p.row][p.col]) return null; // intersection already occupied
    return { game: ID, moves: ((state && state.moves) || []).concat([to]) };
  }

  // Human label for a placement: just the intersection token ("h8"), computed
  // against `state` (the position BEFORE the move). from === to === the square.
  // Only labels a move that applyMove would actually accept — a single-cell
  // placement on an empty, non-terminal square — so moveText never disagrees
  // with applyMove/applyMoveText. Otherwise returns "".
  function moveText(state, from, to) {
    if (from !== to) return "";
    return legalMovesFrom(state, to).length ? to : "";
  }

  // Inverse of moveText and the transport entry point: place at `text` (a square
  // token like "h8") and return the NEXT state, or null if unparseable/illegal in
  // `state`. Records the SAME move token as applyMove, so a State rebuilt via
  // applyMoveText is byte-identical to one built via applyMove for the same move.
  function applyMoveText(state, text) {
    if (typeof text !== "string" || !text.trim()) return null;
    const sq = text.trim();
    return applyMove(state, sq, sq);
  }

  // over on a five-in-a-row (result = the color that just moved) or a full board
  // (result "draw"). A reconstructed board is scanned once for any five; the
  // winner is necessarily the last mover, but we read it off the board so the
  // classification is self-contained.
  function terminal(state) {
    const moves = (state && state.moves) || [];
    const grid = board(state);
    const w = winnerOnBoard(grid);
    if (w) return { over: true, result: w };
    if (moves.length >= N * N) return { over: true, result: "draw" };
    return { over: false };
  }

  // A placement move never captures.
  function isCapture() {
    return false;
  }

  // positionKey(state) -> string  (the image cache-key; VISUAL position only)
  // 225 cells is too long for a per-cell key, so we PACK the board: 2 bits per
  // cell (0 empty, 1 white, 2 black), MSB-first into bytes (225*2 = 450 bits =>
  // 57 bytes), then base64url-encode with no padding (chars [A-Za-z0-9_-]) ->
  // ~76 chars, comfortably under the 115-char limit. Turn/history are excluded,
  // so two lines reaching the same stones share one key (and one cached image).
  function positionKey(state) {
    const grid = board(state);
    const bytes = new Uint8Array(57); // ceil(225*2 / 8)
    let bit = 0; // absolute bit index, MSB-first within each byte
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const v = grid[r][c] === "w" ? 1 : grid[r][c] === "b" ? 2 : 0;
        // write the 2-bit value at [bit, bit+1], MSB first
        const hi = bit >> 3;
        const hiShift = 7 - (bit & 7);
        if (v & 2) bytes[hi] |= 1 << hiShift;
        const lo = (bit + 1) >> 3;
        const loShift = 7 - ((bit + 1) & 7);
        if (v & 1) bytes[lo] |= 1 << loShift;
        bit += 2;
      }
    }
    // base64url, no padding. btoa operates on a binary string.
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  Gage.games[ID] = {
    id: ID,
    boardSize: { rows: N, cols: N },
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
