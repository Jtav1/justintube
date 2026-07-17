-- ============================================================================
-- FILE_VERSIONS
--
-- Stores transcoded copies of an original upload, produced by a future
-- transcode function. Mirrors ORIGINAL_UPLOADS (UUID filename, extension, mime
-- type, size, storage path, status, and video dimensions), but each row is tied
-- to the source upload and the transcode profile that produced it rather than a
-- user and an upload timestamp.
--
-- `transcode_profile_id` is intentionally not FK-enforced yet: the transcode
-- profiles table does not exist at this time. `uuid_name` is a string UUID used
-- as the on-disk filename. Runtime DDL lives in `api/lib/schema.mysql.js` and
-- `api/lib/schema.sqlite.js` and MUST be kept in sync with this file.
-- ============================================================================

CREATE TABLE IF NOT EXISTS FILE_VERSIONS (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  original_upload_id   BIGINT UNSIGNED NOT NULL,
  uuid_name            CHAR(36)        NOT NULL,
  file_extension       VARCHAR(16)     NOT NULL,
  mime_type            VARCHAR(128)    NULL,
  file_size_bytes      BIGINT UNSIGNED NULL,
  storage_path         VARCHAR(512)    NOT NULL,
  status               VARCHAR(32)     NOT NULL DEFAULT 'pending',
  video_width          INT UNSIGNED    NULL,
  video_height         INT UNSIGNED    NULL,
  resolution           VARCHAR(16)     NULL,
  transcode_profile_id BIGINT UNSIGNED NULL,
  created_at           TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_file_versions_uuid (uuid_name),
  UNIQUE KEY uq_file_versions_variant (original_upload_id, transcode_profile_id),
  KEY idx_file_versions_upload (original_upload_id),
  CONSTRAINT fk_file_versions_upload
    FOREIGN KEY (original_upload_id) REFERENCES ORIGINAL_UPLOADS (id) ON DELETE CASCADE,
  CONSTRAINT chk_file_versions_resolution
    CHECK (resolution IN ('240p','360p','480p','720p','1080p','2kHD','4kHD'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
