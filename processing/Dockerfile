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

# Non-root user matching api image (uid/gid 1001); shared volume mount points.
# Chown /app itself (not -R) so npm install below writes node_modules as app,
# avoiding a slow recursive chown pass over it afterward.
RUN addgroup -g 1001 -S app \
  && adduser -u 1001 -S app -G app \
  && mkdir -p /data/shared /media/original /media/transcoded \
  && chown app:app /app \
  && chown -R app:app /data/shared /media

USER app

COPY --chown=app:app package.json ./
RUN npm install

COPY --chown=app:app . .

CMD ["npm", "run", "serve"]
