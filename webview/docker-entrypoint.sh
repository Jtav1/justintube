#!/bin/sh
set -eu

# Reconciles the baked-in "nginx" user to the host-provided PUID/PGID
# (defaults match nginx:alpine's built-in uid/gid), then chowns nginx's
# writable paths and drops from root to that user before exec'ing nginx. Lets
# the same image match arbitrary host file ownership across different
# servers without a rebuild.
PUID="${PUID:-101}"
PGID="${PGID:-101}"

if [ "$(id -g nginx)" != "$PGID" ]; then
  groupmod -o -g "$PGID" nginx
fi
if [ "$(id -u nginx)" != "$PUID" ]; then
  usermod -o -u "$PUID" nginx
fi

chown -R nginx:nginx /usr/share/nginx/html /var/cache/nginx /var/log/nginx /etc/nginx/conf.d /var/run/nginx.pid

# Writes the runtime API origin as a global before nginx serves the SPA, so
# the same image works across environments without a rebuild (see
# src/api/client.js and docs/deployment.md).
cat > /usr/share/nginx/html/config.js <<EOF
window.__RUNTIME_CONFIG__ = { API_BASE_URL: "${API_BASE_URL:-}" };
EOF

exec su-exec nginx "$@"
