#!/bin/sh
# Populate site/lib/ with the shared core the landing site reuses from the
# extension. The site does NOT fork these files — it copies them at build time,
# so the board it renders and the challenge text it builds are byte-identical to
# what the extension uses. site/lib/ is gitignored (no committed duplication);
# both this script (local preview) and the Pages workflow (deploy) regenerate it.
#
# POSIX sh. Run from anywhere: `sh site/build.sh`.
set -eu

# Resolve paths relative to THIS script, not the caller's CWD.
SITE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SITE_DIR/.." && pwd)
SRC_DIR="$REPO_DIR/src"
LIB_DIR="$SITE_DIR/lib"

# The core modules the site loads (in dependency order), plus the shared
# board/panel stylesheet. Each pair is "<src-path-relative-to-src> <dest-name>".
# We flatten into lib/, but vendor/chess.js and games/chess.js share the basename
# "chess.js", so the game module is renamed to chess-game.js to avoid a collision.
set -- \
  "vendor/chess.js"        "chess.js" \
  "fen.js"                 "fen.js" \
  "games/chess.js"         "chess-game.js" \
  "seed.js"                "seed.js" \
  "board.js"               "board.js" \
  "board-image.js"         "board-image.js" \
  "share.js"               "share.js" \
  "transport/protocol.js"  "protocol.js" \
  "styles.css"             "styles.css"

mkdir -p "$LIB_DIR"
# Start clean so a removed/renamed source file can't linger in the artifact.
rm -f "$LIB_DIR"/*.js "$LIB_DIR"/*.css

# Consume the positional args two at a time: <src> <dest>.
while [ "$#" -ge 2 ]; do
  rel=$1
  dest=$2
  shift 2
  src="$SRC_DIR/$rel"
  if [ ! -f "$src" ]; then
    echo "build.sh: missing source: $src" >&2
    exit 1
  fi
  cp "$src" "$LIB_DIR/$dest"
done

echo "build.sh: copied core into $LIB_DIR"
ls -1 "$LIB_DIR"
