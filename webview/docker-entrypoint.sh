#!/bin/sh
set -eu

# Reconciles the baked-in "nginx" user to the host-provided PUID/PGID
# (defaults match nginx:alpine's built-in uid/gid) and chowns the paths
# worker processes write to. Deliberately stays root and execs nginx
# directly rather than su-exec'ing to nginx here: access.log/error.log are
# symlinks to /dev/stdout//dev/stderr, and reopening those by path as a
# non-root uid fails ("Permission denied") since Docker's stdio pipes are
# only reopenable by the process's original (root) owner. Running the master
# as root lets it open those fine; nginx's own `user nginx;` directive (see
# /etc/nginx/nginx.conf) then drops worker processes to the PUID/PGID-mapped
# nginx account for actual request handling.
PUID="${PUID:-101}"
PGID="${PGID:-101}"

if [ "$(id -g nginx)" != "$PGID" ]; then
  groupmod -o -g "$PGID" nginx
fi
if [ "$(id -u nginx)" != "$PUID" ]; then
  usermod -o -u "$PUID" nginx
fi

chown -R nginx:nginx /usr/share/nginx/html /var/cache/nginx

# Writes the runtime API origin as a global before nginx serves the SPA, so
# the same image works across environments without a rebuild (see
# src/api/client.js and docs/deployment.md).
cat > /usr/share/nginx/html/config.js <<EOF
window.__RUNTIME_CONFIG__ = { API_BASE_URL: "${API_BASE_URL:-}" };
EOF

exec "$@"
