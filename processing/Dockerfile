# Build stage: install deps (production only - jest/supertest never ship)
FROM node:24-bookworm-slim AS builder
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# Production stage. Debian (not Alpine) specifically because Intel Quick Sync
# (QSV) hardware transcoding needs libmfx/oneVPL + the iHD VAAPI driver
# (intel-media-va-driver-non-free), which only exist as glibc packages - they
# aren't available for musl/Alpine at all. See docs/deployment.md.
FROM node:24-bookworm-slim
WORKDIR /app

# System deps: Python/pip for yt-dlp + ejs; ffmpeg strongly recommended by
# yt-dlp. Always installs latest (not pinned) - yt-dlp ships frequent
# site-compatibility fixes, and a pinned version can silently start failing
# downloads from a given site as sites change their pages.
#
# intel-media-va-driver-non-free (the iHD VAAPI driver) + libmfx1 + libvpl2
# (Intel Media SDK / oneVPL runtimes ffmpeg's *_qsv codecs link against) live
# in Debian's non-free/contrib components, disabled by default - enable them
# before installing. vainfo is included for on-server diagnostics
# (`docker compose exec processing vainfo`).
RUN sed -i 's/Components: main/Components: main contrib non-free non-free-firmware/' \
      /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
       python3 \
       python3-pip \
       ca-certificates \
       wget \
       ffmpeg \
       intel-media-va-driver-non-free \
       libmfx1 \
       libvpl2 \
       vainfo \
  && rm -rf /var/lib/apt/lists/* \
  && pip install --no-cache-dir --break-system-packages --upgrade \
       yt-dlp \
       yt-dlp-ejs

ENV NODE_ENV=production
EXPOSE 3001

# Non-root user matching api image (uid/gid 1001); shared volume mount
# points. useradd/groupadd/setpriv ship in Debian's base image already (no
# extra package needed) and back docker-entrypoint.sh's PUID/PGID
# reconciliation and privilege drop.
RUN groupadd -g 1001 app \
  && useradd -u 1001 -g app -M -s /usr/sbin/nologin app \
  && mkdir -p /data/shared /media/original /media/transcoded \
  && chown -R app:app /data/shared /media

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app . .
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:3001/health || exit 1

# Stays root here; docker-entrypoint.sh reconciles to PUID/PGID (and, when
# RENDER_GID is set, adds the app user to a matching supplementary group for
# /dev/dri access) and drops privileges via setpriv before exec'ing the CMD
# below.
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["npm", "run", "serve"]
