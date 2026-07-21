// Board -> canvas -> PNG. Game-agnostic, like board.js: it renders ANY Game
// module purely from gameModule.view(state) (a Cell[][]) with NO game-specific
// logic. Used to produce the in-tweet share IMAGE of the current position.
//
// Runs in a normal page AND an extension content script: it only touches
// document.createElement("canvas") + the 2D context, never the live DOM tree, so
// the caller decides whether to insert the canvas or just read its blob.
//
//   Gage.renderBoardCanvas(gameModule, state, opts?) -> HTMLCanvasElement
//   Gage.boardImageBlob(gameModule, state, opts?)    -> Promise<Blob>  (image/png)
//
// opts (all optional):
//   cell   : square size in CSS px (default 80; chess board => 640px).
//   light  : light-square color   (default "#eeeed2").
//   dark   : dark-square color    (default "#769656").
//
// Colors and layout mirror board.js so the image matches the interactive board:
// a square is DARK when (row + col) % 2 === 1; row 0 / col 0 is the top-left of
// view(state). White pieces are filled white with a dark outline for contrast on
// light squares; black pieces are filled near-black.
(function () {
  const Gage = (window.Gage = window.Gage || {});

  const DEFAULT_CELL = 80;
  const LIGHT = "#eeeed2";
  const DARK = "#769656";
  const WHITE_FILL = "#ffffff";
  const WHITE_OUTLINE = "#333333"; // dark edge so white glyphs read on light squares
  const BLACK_FILL = "#111111";
  // Glyph box as a fraction of the cell: chess Unicode pieces have generous
  // side-bearing, so ~0.72 fills the square without clipping neighbours.
  const GLYPH_RATIO = 0.72;

  // renderBoardCanvas(gameModule, state, opts?) -> HTMLCanvasElement
  // Synchronous; returns a detached <canvas> the caller may insert or export.
  function renderBoardCanvas(gameModule, state, opts) {
    opts = opts || {};
    const cells = gameModule.view(state);
    const size = gameModule.boardSize || {
      rows: cells.length,
      cols: (cells[0] && cells[0].length) || 0,
    };
    const rows = size.rows;
    const cols = size.cols;
    const cell = opts.cell > 0 ? opts.cell : DEFAULT_CELL;
    const light = opts.light || LIGHT;
    const dark = opts.dark || DARK;

    const canvas = document.createElement("canvas");
    canvas.width = cols * cell;
    canvas.height = rows * cell;
    const ctx = canvas.getContext("2d");

    // Font sized to the cell; centered so any glyph set (chess, checkers…) lands
    // in the middle of its square regardless of the glyph's own metrics.
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const fontPx = Math.floor(cell * GLYPH_RATIO);
    // Generic family stack: rely on a system Unicode font for the piece glyphs.
    ctx.font =
      fontPx +
      'px "Segoe UI Symbol","Noto Sans Symbols2","Apple Symbols","DejaVu Sans",sans-serif';

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = col * cell;
        const y = row * cell;
        const model = (cells[row] && cells[row][col]) || {};

        // Square background: tint override (if the game supplies one), else the
        // checker color from (row + col) parity — identical rule to board.js.
        const isDark = (row + col) % 2 === 1;
        ctx.fillStyle = model.tint || (isDark ? dark : light);
        ctx.fillRect(x, y, cell, cell);

        if (!model.glyph) continue;

        // Center of the square. A tiny baseline nudge keeps tall glyphs optically
        // centered across fonts.
        const cx = x + cell / 2;
        const cy = y + cell / 2 + cell * 0.02;

        if (model.color === "w") {
          // White piece: white fill with a dark stroke so it stays legible on the
          // light squares (a bare white glyph would vanish there).
          ctx.lineWidth = Math.max(2, fontPx * 0.04);
          ctx.strokeStyle = WHITE_OUTLINE;
          ctx.fillStyle = WHITE_FILL;
          ctx.strokeText(model.glyph, cx, cy);
          ctx.fillText(model.glyph, cx, cy);
        } else {
          // Black piece (or unspecified color): solid near-black fill.
          ctx.fillStyle = BLACK_FILL;
          ctx.fillText(model.glyph, cx, cy);
        }
      }
    }

    return canvas;
  }

  // Twitter's summary_large_image card is a fixed ~1.91:1 and CENTER-CROPS a
  // square image down to the middle strip — so a bare square board loses its top
  // and bottom ranks. renderCardCanvas letterboxes the (square) board into a
  // 1200x630 card so the WHOLE board survives the crop.
  const CARD_W = 1200;
  const CARD_H = 630;
  const CARD_BG = "#302e2b"; // dark frame around the board
  const CARD_PAD = 16;

  function renderCardCanvas(gameModule, state, opts) {
    const board = renderBoardCanvas(gameModule, state, opts); // square
    const canvas = document.createElement("canvas");
    canvas.width = CARD_W;
    canvas.height = CARD_H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = CARD_BG;
    ctx.fillRect(0, 0, CARD_W, CARD_H);
    const side = CARD_H - CARD_PAD * 2; // square board fills the card height
    const x = Math.round((CARD_W - side) / 2);
    const y = Math.round((CARD_H - side) / 2);
    ctx.drawImage(board, x, y, side, side); // scale square board to fit, centered
    return canvas;
  }

  // boardImageBlob(gameModule, state, opts?) -> Promise<Blob>
  // Renders the 1.91:1 CARD (letterboxed board) and resolves its PNG blob. Rejects
  // if the browser can't produce a blob — callers treat the image as best-effort.
  function boardImageBlob(gameModule, state, opts) {
    const canvas = renderCardCanvas(gameModule, state, opts);
    return new Promise(function (resolve, reject) {
      if (typeof canvas.toBlob !== "function") {
        reject(new Error("[gage] canvas.toBlob unsupported"));
        return;
      }
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error("[gage] canvas.toBlob returned null"));
      }, "image/png");
    });
  }

  Gage.renderBoardCanvas = renderBoardCanvas;
  Gage.renderCardCanvas = renderCardCanvas;
  Gage.boardImageBlob = boardImageBlob;
})();
