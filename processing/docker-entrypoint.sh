#!/bin/sh
set -eu

# Reconciles the baked-in "app" user to the host-provided PUID/PGID (defaults
# match the uid/gid the image already creates at build time), then chowns the
# app's writable mount points and drops from root to that user before exec'ing
# the real command. Lets the same image match arbitrary host file ownership
# across different servers without a rebuild.
PUID="${PUID:-99}"
PGID="${PGID:-100}"

if [ "$(id -g app)" != "$PGID" ]; then
  groupmod -o -g "$PGID" app
fi
if [ "$(id -u app)" != "$PUID" ]; then
  usermod -o -u "$PUID" app
fi

# RENDER_GID is separate from PGID on purpose: PGID governs ownership of
# files this service writes (media, shared download handoff), while
# RENDER_GID must match whatever group owns /dev/dri/renderD128 on the host
# (commonly "render" or "video", varying by distro) so the app user can open
# the GPU device for hardware-accelerated transcoding. Find it on the host
# with `stat -c '%g' /dev/dri/renderD128`. Only relevant when hardware
# transcoding is enabled and the device is bind-mounted in; harmless no-op
# otherwise.
if [ -n "${RENDER_GID:-}" ]; then
  if ! getent group render-device >/dev/null 2>&1; then
    groupadd -g "$RENDER_GID" render-device
  elif [ "$(getent group render-device | cut -d: -f3)" != "$RENDER_GID" ]; then
    groupmod -o -g "$RENDER_GID" render-device
  fi
  usermod -aG render-device app
fi

chown -R app:app /app /data/shared /media

exec setpriv --reuid=app --regid=app --init-groups "$@"
