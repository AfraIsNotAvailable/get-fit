#!/usr/bin/env bash
# Install, test and build — the same steps deploy.sh runs in API mode.
#
# pnpm is not installed in the Hermes container the runner lives in, so fall
# back to `npx --yes pnpm@<pinned>`. The lockfile is authoritative either way.
set -euo pipefail

APP="${GETFIT_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$APP"

say() { printf '[ci] %s\n' "$*"; }
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
