# Build stage: install deps (production only - jest/supertest never ship)
FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# Production stage
FROM node:24-alpine
WORKDIR /app

# System deps: Python/pip for yt-dlp + ejs; ffmpeg strongly recommended by
# yt-dlp. Versions are pinned for build reproducibility - yt-dlp ships
# frequent site-compatibility fixes, so bump these deliberately rather than
# silently pulling latest on every image rebuild.
RUN apk add --no-cache \
  python3 \
  py3-pip \
  ca-certificates \
  ffmpeg \
  && pip install --no-cache-dir --break-system-packages \
       yt-dlp==2026.7.4 \
       yt-dlp-ejs==0.8.0

ENV NODE_ENV=production
EXPOSE 3001

# Non-root user matching api image (uid/gid 1001); shared volume mount
# points. shadow + su-exec back docker-entrypoint.sh's PUID/PGID reconciliation.
RUN apk add --no-cache shadow su-exec \
  && addgroup -g 1001 -S app \
  && adduser -u 1001 -S app -G app \
  && mkdir -p /data/shared /media/original /media/transcoded \
  && chown -R app:app /data/shared /media

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app . .
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:3001/health || exit 1

# Stays root here; docker-entrypoint.sh reconciles to PUID/PGID and drops
# privileges via su-exec before exec'ing the CMD below.
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["npm", "run", "serve"]
