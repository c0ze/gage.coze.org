// Generic grid-game renderer + click-to-move input. Transport-independent.
//
// Draws ANY Game module (see src/games/chess.js for the interface): it reads
// boardSize + view(state) to paint the grid, uses legalMovesFrom to highlight
// destinations, and routes moves through applyMove/moveText. There is NO
// game-specific logic here — chess, checkers, reversi all render through this.
//
//   Gage.renderGame(game, state, mountEl, onMove) -> { redraw, getState }
//     game    : a Game module (window.Gage.games[id])
//     state   : initial State (must carry state.game)
//     mountEl : element to append the board into
//     onMove  : ({ from, to, text, seed, state }) => void, fired after a legal
//               move. `seed` is the encoded NEXT state; `state` is that state.
(function () {
  const Gage = (window.Gage = window.Gage || {});

  // Map a grid cell to its Square. Games may define squareAt(); otherwise fall
  // back to a generic "col,row" token so the renderer still functions.
  function squareOf(game, row, col) {
    return typeof game.squareAt === "function"
      ? game.squareAt(row, col)
      : col + "," + row;
  }

  function renderGame(game, state, mount, onMove) {
    const { rows, cols } = game.boardSize;
    const hasCaptureHook = typeof game.isCapture === "function";
    // PLACEMENT games (reversi, gomoku) declare moveKind === "place": a single
    // click on a legal square commits immediately (no select step). MOVEMENT
    // games (chess, checkers) leave moveKind unset and use the two-click flow.
    const isPlacement = game.moveKind === "place";
    let current = state; // latest State
    let selected = null; // Square string, or null (movement games only)
    let targets = []; // legal destination Squares for `selected` (or all placements)
    let captures = new Set(); // subset of `targets` that are captures

    const grid = document.createElement("div");
    grid.className = "gage-board";
    grid.style.gridTemplateColumns = "repeat(" + cols + ", 1fr)";
    grid.style.gridTemplateRows = "repeat(" + rows + ", 1fr)"; // uniform rows — empty ranks must not collapse
    // Responsive glyph: the board keeps a fixed 316px box (see .gage-board), so a
    // 15x15 gomoku board packs far smaller cells than an 8x8 chess board. Scale
    // the glyph to the CELL (316px / span) rather than the fixed 30px so large
    // boards stay legible. Use an explicit px value — a percentage/`em` in
    // font-size would resolve against the PARENT font-size, not the board width,
    // and shrink the glyph to ~1px. span = max(rows, cols); 316/8*0.76 ≈ 30px, so
    // an 8x8 board keeps its original glyph size.
    const span = Math.max(rows, cols) || 8;
    grid.style.fontSize = ((316 / span) * 0.76).toFixed(2) + "px";

    // For placement games, recompute the set of ALL legal placement squares for
    // the side to move (highlighted as move targets, and the click surface).
    function refreshPlacementTargets() {
      if (!isPlacement) return;
      targets = typeof game.legalMoves === "function" ? game.legalMoves(current) : [];
      captures = new Set();
    }

    function draw() {
      const cells = game.view(current);
      const targetSet = new Set(targets);
      grid.innerHTML = "";
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const sq = squareOf(game, row, col);
          const model = (cells[row] && cells[row][col]) || {};
          const el = document.createElement("div");
          const dark = (row + col) % 2 === 1;
          el.className = "gage-sq " + (dark ? "gage-dark" : "gage-light");
          if (model.tint) el.style.background = model.tint;
          if (selected === sq) el.classList.add("gage-sel");
          if (targetSet.has(sq)) {
            // Prefer the game's capture info (handles en passant, whose
            // destination is empty); else fall back to "destination has a piece".
            const cap = hasCaptureHook ? captures.has(sq) : !!model.glyph;
            el.classList.add(cap ? "gage-capture" : "gage-move");
          }
          if (model.glyph) {
            el.textContent = model.glyph;
            if (model.color === "w") el.classList.add("gage-white");
            else if (model.color === "b") el.classList.add("gage-black");
          }
          el.addEventListener("click", () => onClick(sq));
          grid.appendChild(el);
        }
      }
    }

    // Select `sq` if it has legal moves this turn; also precompute which of its
    // targets are captures (once per selection, not per redraw).
    function select(sq) {
      const moves = game.legalMovesFrom(current, sq);
      if (moves.length) {
        selected = sq;
        targets = moves;
        captures = hasCaptureHook
          ? new Set(moves.filter((to) => game.isCapture(current, sq, to)))
          : new Set();
      } else {
        clearSelection();
      }
    }

    function clearSelection() {
      selected = null;
      targets = [];
      captures = new Set();
    }

    function onClick(sq) {
      // Freeze the board once the game is over. Checkmate/stalemate have no legal
      // moves anyway, but draws by rule (threefold, 50-move, insufficient
      // material) still generate legal moves, so guard explicitly.
      if (game.terminal(current).over) return;
      // PLACEMENT: a single click on a legal square commits immediately. from ===
      // to === sq (see the placement-game contract). No select step.
      if (isPlacement) {
        if (targets.indexOf(sq) === -1) return; // not a legal placement — ignore
        const text = game.moveText(current, sq, sq);
        const next = game.applyMove(current, sq, sq);
        if (next) {
          current = next;
          refreshPlacementTargets();
          draw();
          if (onMove) {
            onMove({ from: sq, to: sq, text, seed: Gage.encodeSeed(current), state: current });
          }
        } else {
          draw(); // illegal after all (shouldn't happen)
        }
        return;
      }
      if (selected && targets.indexOf(sq) !== -1) {
        // Commit the move through the game module (which enforces legality).
        const from = selected;
        const to = sq;
        const text = game.moveText(current, from, to);
        const next = game.applyMove(current, from, to);
        clearSelection();
        if (next) {
          current = next;
          draw();
          if (onMove) {
            onMove({ from, to, text, seed: Gage.encodeSeed(current), state: current });
          }
        } else {
          draw(); // illegal after all (shouldn't happen) — just clear selection
        }
        return;
      }
      select(sq);
      draw();
    }

    mount.appendChild(grid);
    refreshPlacementTargets(); // no-op for movement games; seeds placement hints
    draw();
    return {
      redraw: draw,
      getState: () => current,
    };
  }

  Gage.renderGame = renderGame;
})();
