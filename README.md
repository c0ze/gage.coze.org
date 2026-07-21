# Gage

Play chess turn-by-turn on X (Twitter) with **no Twitter API**. A browser
extension runs inside the X page, so it can read the origin tweet's ID, draw a
live board in-place, and drive the composer — the things a static site can't.

## Why an extension (the trilemma)

No-API Twitter lets you pick two of three:

|                  | Reach (challenge anyone) | No timeline sprawl | No install |
| ---------------- | :----------------------: | :----------------: | :--------: |
| Public tweets    |            ✅            |         ❌         |     ✅     |
| DMs              |            ❌            |         ✅         |     ✅     |
| **Extension**    |    installers only       |         ✅         |     ❌     |

We chose the extension: it kills the threading/preview/cheating limits, at the
cost of both players needing to install it (desktop Chrome).

This is being generalized into a multi-game, turn-by-turn "correspondence board
games on X" platform. Chess is first; checkers, reversi and other 8×8-grid games
follow. The game **logic** is pure and portable (no DOM, no extension/Twitter
APIs) so two clients can share one core: this desktop extension, and a future
mobile PWA. Rendering is a separate, client-side concern.

## Status — v1 (generic core + real chess)

- ✅ Loads as an MV3 extension on `x.com` / `twitter.com`.
- ✅ Renders an interactive board panel; legal-move dots, click to move.
- ✅ **Real legality** — chess is backed by vendored `chess.js` (check, mate,
  stalemate, castling, en passant, promotion, draws).
- ✅ Generic renderer draws **any** Game module; chess is the first.
- ✅ Self-describing seeds (base64url, UTF-8-safe) that route to a game module.
- ✅ **Transport decided: public threaded replies.** One move = one tweet; the
  reply chain *is* the move list. The pure protocol (tweet ↔ move) and thread
  reconstruction (replay move texts → State, with cheat/desync detection) are
  implemented and tested under `src/transport/`.
- ✅ **Live-X DOM layer wired** — `Gage.threadTransport`
  (`src/transport/thread-dom.js`) reads the thread, fills the reply composer
  (DraftJS via `execCommand("insertText")`), and observes new replies, using
  selectors **verified against live X on 2026-07-22**. Dev-safe: `AUTO_SEND` is
  off, so it fills a reply but the player presses "Reply" — nothing posts
  unattended. (X's data-testids will drift; the file header says how to re-verify.)

## Game module interface

A Game module is a plain object at `window.Gage.games[id]` that any grid game
implements. Squares are algebraic strings ("e2") consistently. Full contract and
`Cell` shape are documented in the header of `src/games/chess.js`:

- `id`, `boardSize {rows, cols}`
- `initialState() -> State` (State carries its own `game` id — seeds self-describe)
- `view(state) -> Cell[][]` where `Cell = { glyph?, color?: "w"|"b", tint? }`
- `turn(state) -> "w"|"b"`
- `legalMovesFrom(state, sq) -> Square[]`
- `applyMove(state, from, to, opts?) -> State | null` (null if illegal)
- `moveText(state, from, to) -> string` (human label, e.g. SAN "Nf3")
- `applyMoveText(state, text) -> State | null` (optional; inverse of `moveText` —
  apply a human move token, null if unparseable/illegal. Transport entry point:
  the thread carries move *text*, and this rebuilds a State identical to the
  `applyMove` path.)
- `terminal(state) -> { over, result?: "w"|"b"|"draw" }`
- `squareAt(row, col) -> Square` (optional; renderer falls back to `"col,row"`)
- `isCapture(state, from, to) -> boolean` (optional; flags captures the renderer
  can't see, e.g. en passant)

The renderer (`src/board.js`) consumes only this interface, so a new game =
a new module under `src/games/` with no renderer changes. Chess `State` stores
the move list (`{ game, moves }`) and replays it into chess.js, so repetition
history survives — a bare FEN would lose it.

## Load it

1. `chrome://extensions` → enable Developer mode.
2. "Load unpacked" → select this folder.
3. Open `x.com`. The board panel appears bottom-right.

## Layout

Loaded in dependency order by the manifest:

- `manifest.json` — MV3, injects the content scripts on X.
- `src/vendor/chess.js` — vendored **chess.js v1.4.0** (BSD-2-Clause), wrapped to
  expose `window.Chess` for classic content scripts (no bundler / ES modules).
- `src/fen.js` — FEN constants + parse/serialize (pure).
- `src/games/chess.js` — chess **Game module** (pure); wraps chess.js.
- `src/board.js` — generic grid-game renderer + click-to-move (pure, no game logic).
- `src/seed.js` — self-describing state ↔ base64url seed; routes to a game module.
- `src/transport/protocol.js` — pure tweet ↔ move codec (`Gage.protocol`); exact
  tweet grammar in its header.
- `src/transport/reconstruct.js` — replay parsed move texts into a State
  (`Gage.reconstruct`); reports the first illegal move as desync/cheat.
- `src/transport/thread-dom.js` — DOM-coupled X layer (`Gage.threadTransport`),
  **wired** against live X (2026-07-22); header lists the selectors + how to
  re-verify when they drift.
- `src/content.js` — mounts the panel; binds the transport modules (local
  practice board works today; the live thread hook is present but commented until
  the game orchestration is finished).
- `src/styles.css` — panel + board styling.

Content scripts are classic scripts (not ES modules) sharing a `window.Gage`
namespace via IIFEs; the manifest loads them in order.

## Transport — public threaded replies

Moves ride the thread, not a seed: a full seed won't fit in ~280 chars, so state
is reconstructed by **walking the reply chain**. One move = one tweet, detected
by the `#gage` marker; the move token lives in a `[...]` slot so it survives
surrounding human text. The **root** tweet is a challenge that declares the game
and carries move 1; each **reply** carries exactly one move.

    Challenge (root):  ♟ Chess challenge @rival — your move. #gage #chess [e4]
    Reply:             [Nf6] #gage

`Gage.reconstruct(game, moveTexts)` replays the parsed tokens through the module;
the first token that won't apply (illegal/unparseable in its position) stops the
walk and is returned in `error` — that is the desync / cheat signal. Full grammar
is in `src/transport/protocol.js`.

## Board-card Worker (`worker/`)

The in-tweet share card + human on-ramp are served by a small Cloudflare Worker
in [`worker/`](worker/) — routed for `gage.coze.org/g/*` (Twitter/OG card HTML
for a seed) and `gage.coze.org/img/*` (the board PNG, cached in R2). It has **no
game logic**: it base64url-decodes the seed's `meta` and reads/writes R2.
GitHub Pages still serves the rest of the site. Deploy:

    cd worker
    wrangler login
    wrangler r2 bucket create gage-board-cache
    wrangler deploy            # also installs the /g/* and /img/* routes

The routes require `coze.org` to be a zone on the Cloudflare account. See
[`worker/README.md`](worker/README.md) for the full contract and test
(`node worker/test/worker.test.mjs`).

## Next

1. **Finish the game orchestration:** the DOM layer is wired, so what's left is
   flipping on the `src/content.js` hook — new-game detection (challenge vs
   reply), the rival's @handle, hydrating from a conversation page, and an
   end-to-end smoke test (then flip `AUTO_SEND` on in `thread-dom.js`).
2. **More games:** add `src/games/checkers.js`, `src/games/reversi.js` behind the
   same interface — no renderer changes.
3. **Promotion UI:** the renderer defaults promotions to a queen; add a chooser.
4. **Anti-cheat:** HMAC-sign the seed so a hand-edited position is detectable.
5. **Mobile PWA client:** reuse `src/games/*` + `src/seed.js` unchanged; only the
   renderer/host differ.
