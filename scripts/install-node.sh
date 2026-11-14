#!/usr/bin/env bash
# Install a Node >= 24 runtime for the API service, without apt and without root.
#
# Debian 13 ships Node 20, and node:sqlite (DatabaseSync) needs >= 22.5. The
# official arm64 tarball goes into ~/.local/node24 and the unit points at it.
set -euo pipefail

DEST="${NODE_DEST:-$HOME/.local/node24}"
BASE="https://nodejs.org/dist/latest-v24.x"

case "$(uname -m)" in
  aarch64|arm64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) echo "unsupported arch $(uname -m)"; exit 1 ;;
esac

if [ -x "$DEST/bin/node" ] && "$DEST/bin/node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  echo "node $("$DEST/bin/node" -v) already at $DEST"
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "fetching $BASE/SHASUMS256.txt"
curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/sums"
FILE=$(awk -v a="linux-$ARCH.tar.xz" '$2 ~ a {print $2; exit}' "$TMP/sums")
[ -n "$FILE" ] || { echo "no linux-$ARCH tarball in SHASUMS"; exit 1; }
echo "downloading $FILE"
curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
(cd "$TMP" && grep " $FILE$" sums | sha256sum -c -)

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
mkdir -p "$DEST"
tar -xJf "$TMP/$FILE" -C "$DEST" --strip-components=1
"$DEST/bin/node" -v
echo "installed to $DEST"
