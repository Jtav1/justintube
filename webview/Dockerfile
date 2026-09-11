FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

RUN npm run build

FROM nginx:1.27-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker-entrypoint.sh /docker-entrypoint.sh

# nginx:1.27-alpine ships an unprivileged "nginx" user (uid 101); non-root
# can't bind port 80, so nginx.conf listens on 8080 instead. shadow backs
# docker-entrypoint.sh's PUID/PGID reconciliation (usermod/groupmod).
RUN apk add --no-cache shadow \
  && chown -R nginx:nginx /usr/share/nginx/html /var/cache/nginx \
  && chmod +x /docker-entrypoint.sh

# Stays root: docker-entrypoint.sh reconciles the nginx user to PUID/PGID,
# then execs nginx directly as root so its master process can open the
# access.log/error.log symlinks (see docker-entrypoint.sh); nginx's own
# `user nginx;` directive drops worker processes to that PUID/PGID.
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:8080/ || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
