# Build stage: install deps (including optional better-sqlite3)
FROM node:24-alpine AS builder
WORKDIR /app

# Build deps for native optionalDependencies (e.g. better-sqlite3)
RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install

# Production stage
FROM node:24-alpine
WORKDIR /app

ENV NODE_ENV=production
EXPOSE 3000

# Run as non-root; shared volume mount points for media + yt-dlp handoff.
# shadow + su-exec back docker-entrypoint.sh's PUID/PGID reconciliation.
RUN apk add --no-cache shadow su-exec \
  && addgroup -g 1001 -S app \
  && adduser -u 1001 -S app -G app \
  && mkdir -p /media /sitedata /data/shared \
  && chown -R app:app /media /sitedata /data/shared

# Copy installed dependencies from builder, setting ownership as files are laid down
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app . .
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Stays root here; docker-entrypoint.sh reconciles to PUID/PGID and drops
# privileges via su-exec before exec'ing the CMD below.
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "index.js"]
