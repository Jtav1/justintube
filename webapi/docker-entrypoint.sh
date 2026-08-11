#!/bin/sh
set -eu

# Reconciles the baked-in "app" user to the host-provided PUID/PGID (defaults
# match the uid/gid the image already creates at build time), then chowns the
# app's writable mount points and drops from root to that user before exec'ing
# the real command. Lets the same image match arbitrary host file ownership
# across different servers without a rebuild.
PUID="${PUID:-1001}"
PGID="${PGID:-1001}"

if [ "$(id -g app)" != "$PGID" ]; then
  groupmod -o -g "$PGID" app
fi
if [ "$(id -u app)" != "$PUID" ]; then
  usermod -o -u "$PUID" app
fi

chown -R app:app /app /media /sitedata /data/shared

exec su-exec app "$@"
