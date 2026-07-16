import { DB_CLIENT, exec } from "./db.js";

/**
 * MySQL DDL for the ORIGINAL_UPLOADS table. Kept in sync with
 * `api/db/schema/original_uploads.sql`.
 *
 * @type {string}
 */
const ORIGINAL_UPLOADS_DDL_MYSQL = `
  CREATE TABLE IF NOT EXISTS ORIGINAL_UPLOADS (
    id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    original_filename VARCHAR(255)    NOT NULL,
    uuid_name         CHAR(36)        NOT NULL,
    file_extension    VARCHAR(16)     NOT NULL,
    mime_type         VARCHAR(128)    NULL,
    file_size_bytes   BIGINT UNSIGNED NULL,
    storage_path      VARCHAR(512)    NOT NULL,
    status            VARCHAR(32)     NOT NULL DEFAULT 'uploaded',
    user_id           BIGINT UNSIGNED NULL,
    uploaded_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_uuid_name (uuid_name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * SQLite DDL for the ORIGINAL_UPLOADS table (local dev). Mirrors the MySQL
 * definition using SQLite-compatible types.
 *
 * @type {string}
 */
const ORIGINAL_UPLOADS_DDL_SQLITE = `
  CREATE TABLE IF NOT EXISTS ORIGINAL_UPLOADS (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    original_filename TEXT    NOT NULL,
    uuid_name         TEXT    NOT NULL UNIQUE,
    file_extension    TEXT    NOT NULL,
    mime_type         TEXT,
    file_size_bytes   INTEGER,
    storage_path      TEXT    NOT NULL,
    status            TEXT    NOT NULL DEFAULT 'uploaded',
    user_id           INTEGER,
    uploaded_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

/**
 * Ensures all application tables exist, creating them if necessary. Safe to run
 * on every startup because each statement uses CREATE TABLE IF NOT EXISTS. The
 * DDL dialect is chosen based on the active DB_CLIENT.
 *
 * @returns {Promise<void>} Resolves once schema creation has completed.
 */
export async function ensureSchema() {
  const ddl =
    DB_CLIENT === "mysql"
      ? ORIGINAL_UPLOADS_DDL_MYSQL
      : ORIGINAL_UPLOADS_DDL_SQLITE;
  await exec(ddl);
}
