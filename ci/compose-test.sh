#!/bin/sh
# Checks that the shipped docker-compose.yml starts the image with its
# bind-mounted ./data in two cases:
#   1. a fresh install: ./data does not exist yet (Docker creates it as root);
#   2. an existing install: ./data and bot.db are owned by root (older images,
#      or a directory created by hand), with data that must survive.
# In both the bot must open the database and own its files. Discord login
# fails with the fake token, which is expected.
#
# Needs a Docker daemon and the compose plugin (CI: docker image + dind).
# Usage: sh ci/compose-test.sh [image]   (default: builds the Dockerfile)
set -eu

IMAGE="${1:-}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d "$ROOT/.compose-test.XXXXXX")
NET=zammad-kc_default
CREATED_NET=

cleanup() {
  for d in "$WORK"/*/; do
    [ -f "$d/docker-compose.yml" ] && (cd "$d" && docker compose down -v --remove-orphans >/dev/null 2>&1 || true)
  done
  # Files written by the container belong to its user; remove them from inside.
  docker run --rm -v "$WORK:/w" --entrypoint sh "$IMAGE" -c 'rm -rf /w/*' >/dev/null 2>&1 || true
  rm -rf "$WORK"
  [ -n "$CREATED_NET" ] && docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ -z "$IMAGE" ]; then
  IMAGE=zammad-kc-discord-bot:compose-test
  docker build -q -t "$IMAGE" "$ROOT" >/dev/null
fi
# The compose file names this image; tag the one under test with it.
docker tag "$IMAGE" zammad-kc-discord-bot:latest

if ! docker network inspect "$NET" >/dev/null 2>&1; then
  docker network create "$NET" >/dev/null
  CREATED_NET=1
fi

BOT_UID=$(docker run --rm --entrypoint id "$IMAGE" -u bot)

# Runs node as root in the image with ./data mounted, for setup and checks.
node_in_data() {
  docker run --rm --user 0 --entrypoint node -v "$1/data:/app/data" "$IMAGE" -e "$2"
}

run_case() {
  name=$1
  dir="$WORK/$name"
  echo "--- $name"
  (
    cd "$dir"
    docker compose up -d --no-build --pull never >/dev/null
    ok=
    for _ in $(seq 1 30); do
      if docker compose logs discord-bot 2>&1 | grep -q '"msg":"Database initialized"'; then ok=1; break; fi
      if docker compose logs discord-bot 2>&1 | grep -q 'unable to open database file'; then break; fi
      sleep 2
    done
    docker compose logs discord-bot 2>&1 | grep -E 'Database initialized|unable to open|SETTINGS_ENCRYPTION_KEY|Error' | cut -c1-300 || true
    [ -n "$ok" ] || { echo "FAIL ($name): the database was not opened"; exit 1; }
    docker compose down >/dev/null
  )
  owners=$(docker run --rm -v "$dir/data:/d" --entrypoint sh "$IMAGE" -c 'stat -c "%u %n" /d /d/*')
  echo "$owners"
  echo "$owners" | awk -v u="$BOT_UID" '$1 != u { bad=1 } END { exit bad }' \
    || { echo "FAIL ($name): files in ./data are not owned by bot (uid $BOT_UID)"; exit 1; }
}

setup_dir() {
  mkdir -p "$WORK/$1"
  cp "$ROOT/docker-compose.yml" "$WORK/$1/"
  cat > "$WORK/$1/.env" <<'ENV'
DISCORD_TOKEN=fake-token-for-compose-test
DISCORD_CLIENT_ID=1
DISCORD_GUILD_ID=1
DISCORD_TICKETS_CHANNEL_ID=1
ZAMMAD_BASE_URL=http://127.0.0.1:9
ZAMMAD_API_TOKEN=fake
ZAMMAD_WEBHOOK_SECRET=fake
LOG_LEVEL=info
ENV
}

# 1. Fresh install: no ./data at all.
setup_dir fresh
run_case fresh

# 2. Existing install: root-owned ./data with a database holding a marker row.
setup_dir existing
node_in_data "$WORK/existing" '
  const D = require("better-sqlite3");
  const d = new D("/app/data/bot.db");
  d.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  d.prepare("INSERT INTO settings VALUES (?, ?)").run("COMPOSE_TEST_MARKER", "kept");
  d.close();'
docker run --rm -v "$WORK/existing/data:/d" --entrypoint sh "$IMAGE" -c 'chmod 755 /d && chmod 644 /d/bot.db && stat -c "before: %u %n" /d /d/bot.db'
run_case existing
marker=$(node_in_data "$WORK/existing" '
  const D = require("better-sqlite3");
  const d = new D("/app/data/bot.db", { readonly: true });
  console.log(d.prepare("SELECT value FROM settings WHERE key = ?").get("COMPOSE_TEST_MARKER")?.value ?? "missing");')
[ "$marker" = "kept" ] || { echo "FAIL (existing): data in bot.db was lost ($marker)"; exit 1; }
echo "existing data kept"

echo "compose test passed"
