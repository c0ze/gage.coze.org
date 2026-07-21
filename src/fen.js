// FEN parse/serialize. Pure, transport-independent.
// Board is board[row][col]: row 0 = rank 8 (top), col 0 = file a.
(function () {
  const Gage = (window.Gage = window.Gage || {});
  const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

  function parseFEN(fen) {
    const [placement, turn = "w", castling = "-", ep = "-", half = "0", full = "1"] =
      fen.trim().split(/\s+/);
    const board = [];
    for (const rankStr of placement.split("/")) {
      const row = [];
      for (const ch of rankStr) {
        if (/\d/.test(ch)) {
          for (let i = 0; i < Number(ch); i++) row.push(null);
        } else {
          row.push(ch);
        }
      }
      board.push(row);
    }
    return { board, turn, castling, ep, half: Number(half), full: Number(full) };
  }

  function toFEN(state) {
    const placement = state.board
      .map((row) => {
        let out = "";
        let empty = 0;
        for (const cell of row) {
          if (cell == null) {
            empty++;
          } else {
            if (empty) {
              out += empty;
              empty = 0;
            }
            out += cell;
          }
        }
        if (empty) out += empty;
        return out;
      })
      .join("/");
    return [placement, state.turn, state.castling, state.ep, state.half, state.full].join(" ");
  }

  Gage.START_FEN = START_FEN;
  Gage.parseFEN = parseFEN;
  Gage.toFEN = toFEN;
})();
