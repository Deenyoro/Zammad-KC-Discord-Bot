#!/bin/sh
# Runs ESLint from tools/lint, installing its pinned dependencies first when
# they are missing or older than the lockfile. Extra arguments go to eslint.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
LINT="$ROOT/tools/lint"
if [ ! -x "$LINT/node_modules/.bin/eslint" ] || [ "$LINT/package-lock.json" -nt "$LINT/node_modules/.package-lock.json" ]; then
  npm ci --prefix "$LINT" --no-audit --no-fund --loglevel=error ${NPM_CACHE_DIR:+--cache "$NPM_CACHE_DIR"}
fi
cd "$ROOT"
[ $# -gt 0 ] || set -- src test
exec "$LINT/node_modules/.bin/eslint" "$@"
