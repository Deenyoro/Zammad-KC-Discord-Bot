#!/bin/sh
# Started as root (the default with docker compose and a bind-mounted ./data):
# give the bot user ownership of data/ (a fresh ./data is created by Docker as
# root, older installs may hold root-owned files), then drop to that user.
# Started as any other user (Kubernetes runAsUser, docker run --user): run
# directly; the platform is then responsible for a writable data/.
set -eu

DATA_DIR=/app/data

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # Only touch what is not already owned by bot, so restarts do not rewrite
  # ownership of the whole directory every time.
  find "$DATA_DIR" \( ! -user bot -o ! -group bot \) -exec chown -h bot:bot {} +
  exec su-exec bot:bot "$@"
fi

exec "$@"
