/**
 * MySQL DDL for the ORIGINAL_UPLOADS table. Kept in sync with the master schema
 * reference in `api/db/schema/original_uploads.sql` and the SQLite variant in
 * `api/lib/schema.sqlite.js`.
 *
 * @type {string}
 */
export const ORIGINAL_UPLOADS_DDL = `
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
 * All DDL statements required to build the MySQL schema, in execution order.
 *
 * @type {string[]}
 */
export const SCHEMA_STATEMENTS = [ORIGINAL_UPLOADS_DDL];
