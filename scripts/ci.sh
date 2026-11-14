#!/usr/bin/env bash
# Install, test and build — the same steps deploy.sh runs in API mode.
#
# pnpm is not installed in the Hermes container the runner lives in, so fall
# back to `npx --yes pnpm@<pinned>`. The lockfile is authoritative either way.
set -euo pipefail

APP="${GETFIT_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$APP"

say() { printf '[ci] %s\n' "$*"; }

# Debian ships Node 20 and `node:sqlite` needs >= 22.5, so prefer the runtime the API
# unit runs, plus the pnpm that was installed beside it. Without this the test step
# fails on the db package and the deploy blames the code.
if [ -d "$HOME/.local/node24/bin" ]; then PATH="$HOME/.local/node24/bin:$PATH"; fi
if [ -d "$HOME/.local/bin" ]; then PATH="$HOME/.local/bin:$PATH"; fi
export PATH
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
  printf '[ci] node %s is too old: node:sqlite needs >= 22.5 (run scripts/install-node.sh)\n' "$(node -v 2>/dev/null || echo none)" >&2
  exit 1
fi

PNPM="$(command -v pnpm || true)"
if [ -z "$PNPM" ]; then
  PNPM="npx --yes pnpm@12.15.0"
fi

say "node $(node -v)"
say "install"
$PNPM install --frozen-lockfile
say "tests"
$PNPM -r test
say "build"
cd apps/server && node build.mjs
