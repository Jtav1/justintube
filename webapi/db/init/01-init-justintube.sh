#!/bin/bash
#
# Initializes the Justintube database on first container startup.
#
# This script is copied into /docker-entrypoint-initdb.d and run automatically
# by the MySQL image the first time the data volume is created. It logs in as
# the root user and creates the application database along with a dedicated
# application user that owns (has full privileges on) that database.
#
# Parameters (provided via container environment):
#   MYSQL_ROOT_PASSWORD - password for the MySQL root account (login).
#   JUSTINTUBE_DB       - name of the application database to create.
#   JUSTINTUBE_USER     - name of the application user to create.
#   JUSTINTUBE_PASSWORD - password for the application user.
#
# Returns:
#   Exits 0 on success; non-zero if any SQL statement fails.
#
set -euo pipefail

mysql --user=root --password="${MYSQL_ROOT_PASSWORD}" <<-EOSQL
  CREATE DATABASE IF NOT EXISTS \`${JUSTINTUBE_DB}\`
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

  CREATE USER IF NOT EXISTS '${JUSTINTUBE_USER}'@'%'
    IDENTIFIED BY '${JUSTINTUBE_PASSWORD}';

  GRANT ALL PRIVILEGES ON \`${JUSTINTUBE_DB}\`.* TO '${JUSTINTUBE_USER}'@'%';

  FLUSH PRIVILEGES;
EOSQL
