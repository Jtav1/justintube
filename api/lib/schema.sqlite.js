/**
 * SQLite DDL for the ORIGINAL_UPLOADS table (local dev). Kept in sync with the
 * master schema reference in `api/db/schema/original_uploads.sql` and mirrors
 * the MySQL definition in `api/lib/schema.mysql.js` using SQLite-compatible
 * types.
 *
 * @type {string}
 */
export const ORIGINAL_UPLOADS_DDL = `
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
 * All DDL statements required to build the SQLite schema, in execution order.
 *
 * @type {string[]}
 */
export const SCHEMA_STATEMENTS = [ORIGINAL_UPLOADS_DDL];
