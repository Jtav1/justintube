#!/bin/sh
set -eu

# Writes the runtime API origin as a global before nginx serves the SPA, so
# the same image works across environments without a rebuild (see
# src/api/client.js and docs/deployment.md).
cat > /usr/share/nginx/html/config.js <<EOF
window.__RUNTIME_CONFIG__ = { API_BASE_URL: "${API_BASE_URL:-}" };
EOF

exec "$@"
