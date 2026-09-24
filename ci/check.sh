#!/bin/sh
# Pre-image gate for the GitLab pipeline: install, type check, build and test
# on the same Node major the Dockerfile ships, and refuse a release whose
# version does not match package.json. Runs in node:<N>-alpine (POSIX sh).
set -eu

# 1. Same Node major as the Dockerfile's FROM lines (node:24-alpine today), so
#    the tests exercise the runtime the image actually ships.
DOCKER_NODE=$(sed -n 's/^FROM node:\([0-9][0-9]*\).*/\1/p' Dockerfile | head -n 1)
CI_NODE=$(node -p 'process.versions.node.split(".")[0]')
echo "node $(node --version), npm $(npm --version); Dockerfile uses node:$DOCKER_NODE"
if [ -z "$DOCKER_NODE" ] || [ "$CI_NODE" != "$DOCKER_NODE" ]; then
  echo "This job runs Node $CI_NODE but the Dockerfile uses node:${DOCKER_NODE:-?}: update NODE_IMAGE in .gitlab-ci.yml"
  exit 1
fi

# 2. A release (v* tag, or RELEASE_VERSION on a manual run) must carry that
#    version in package.json and package-lock.json. Untagged runs are not checked.
VERSION="${RELEASE_VERSION:-${CI_COMMIT_TAG:-}}"
VERSION="${VERSION#v}"
if [ -n "$VERSION" ]; then
  PKG_VERSION=$(node -p 'require("./package.json").version')
  LOCK_VERSION=$(node -p 'require("./package-lock.json").version')
  if [ "$PKG_VERSION" != "$VERSION" ] || [ "$LOCK_VERSION" != "$VERSION" ]; then
    echo "Release is $VERSION but package.json is $PKG_VERSION and package-lock.json is $LOCK_VERSION: bump both first"
    exit 1
  fi
  echo "version $VERSION matches package.json and package-lock.json"
else
  echo "untagged build; skipping version check"
fi

# 3. Install exactly the lockfile, like the Dockerfile's build stage.
# NPM_CACHE_DIR is set by the CI job (a cached dir); locally npm's own cache is used.
npm ci --no-audit --no-fund --prefer-offline ${NPM_CACHE_DIR:+--cache "$NPM_CACHE_DIR"}

# 4. The native modules the bot loads at runtime must load on this libc
#    (musl on Alpine): better-sqlite3 is not touched by the tests.
node -e 'const D = require("better-sqlite3"); new D(":memory:").prepare("select 1").get(); require("sharp"); console.log("better-sqlite3 and sharp load")'

# 5. Type check, compile (what the image's build stage runs), then the tests
#    (Zammad webhook HMAC auth, attachment image conversion via sharp).
npm run typecheck
npm run build
npm test
