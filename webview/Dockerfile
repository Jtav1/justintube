FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# nginx:1.27-alpine ships an unprivileged "nginx" user (uid 101); non-root
# can't bind port 80, so nginx.conf listens on 8080 instead.
RUN chown -R nginx:nginx /usr/share/nginx/html /var/cache/nginx /var/log/nginx /etc/nginx/conf.d \
  && touch /var/run/nginx.pid \
  && chown nginx:nginx /var/run/nginx.pid

USER nginx
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:8080/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
