-- ============================================================================
-- MASTER SCHEMA REFERENCE
--
-- This file is the authoritative, human-readable reference design for the
-- Justintube database. It describes every table in MySQL-compatible syntax.
-- The runtime DDL executed by the API lives in `api/lib/schema.mysql.js`
-- (MySQL) and `api/lib/schema.sqlite.js` (SQLite) and MUST be kept in sync
-- with the definitions below.
-- ============================================================================
--
-- ORIGINAL_UPLOADS
--
-- Stores one record per raw file uploaded to Justintube. The file is written to
-- disk under MEDIA_STORAGE_DIRECTORY using `uuid_name` (+ extension) as its name,
-- so the UUID is the single source of truth linking the filesystem and this table.
--
-- The `user_id` column is intentionally left nullable for now; it will be
-- populated once authentication is wired into the upload flow.

-- The video_width / video_height / resolution columns capture the source
-- file's pixel dimensions and a normalized resolution label. `resolution` is
-- constrained to the shared set of allowed labels (see the OpenAPI `Resolution`
-- enum). These columns are added in-place on existing databases by the column
-- migration runner in `api/lib/migrations.js`.

CREATE TABLE IF NOT EXISTS ORIGINAL_UPLOADS (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  original_filename VARCHAR(255)    NOT NULL,
  uuid_name         CHAR(36)        NOT NULL,
  file_extension    VARCHAR(16)     NOT NULL,
  mime_type         VARCHAR(128)    NULL,
  file_size_bytes   BIGINT UNSIGNED NULL,
  storage_path      VARCHAR(512)    NOT NULL,
  status            VARCHAR(32)     NOT NULL DEFAULT 'uploaded',
  video_width       INT UNSIGNED    NULL,
  video_height      INT UNSIGNED    NULL,
  resolution        VARCHAR(16)     NULL,
  user_id           BIGINT UNSIGNED NULL,
  uploaded_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_uuid_name (uuid_name),
  CONSTRAINT chk_original_uploads_resolution
    CHECK (resolution IN ('240p','360p','480p','720p','1080p','2kHD','4kHD'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
