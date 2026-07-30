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

# Run as non-root; shared volume mount points for media + yt-dlp handoff
RUN addgroup -g 1001 -S app \
  && adduser -u 1001 -S app -G app \
  && mkdir -p /media /data/shared \
  && chown -R app:app /media /data/shared

# Copy installed dependencies from builder, setting ownership as files are laid down
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app . .
USER app

CMD ["node", "index.js"]
