# Bakes the Justintube init script into the image so a fresh MySQL data
# volume bootstraps the app database/user on any host with no bind-mounted
# host directory required (see docker-compose-prod.yml).
FROM mysql:8.4

COPY webapi/db/init/01-init-justintube.sh /docker-entrypoint-initdb.d/01-init-justintube.sh
