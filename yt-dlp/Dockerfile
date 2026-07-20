FROM node:24-alpine
WORKDIR /app

# System deps: Python/pip for yt-dlp + ejs; ffmpeg strongly recommended by yt-dlp
RUN apk add --no-cache \
    python3 \
    py3-pip \
    ca-certificates \
    ffmpeg \
  && pip install --no-cache-dir --break-system-packages yt-dlp yt-dlp-ejs

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

# Non-root user matching api image (uid/gid 1001); shared volume mount points
RUN addgroup -g 1001 -S app \
  && adduser -u 1001 -S app -G app \
  && mkdir -p /data/shared /media \
  && chown -R app:app /app /data/shared /media

USER app

CMD ["npm", "run", "serve"]
