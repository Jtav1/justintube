-- ============================================================================
-- VIDEO_METADATA
--
-- Screen-viewable metadata for a single uploaded video. There is exactly one
-- row per ORIGINAL_UPLOADS record (enforced by the UNIQUE key on
-- original_upload_id), so this table holds the human-facing fields that are
-- edited and displayed independently of the raw file: title, description,
-- lifetime view count, visibility, and whether comments are enabled.
--
-- `visibility` is constrained to the shared set of visibility values, matching
-- the OpenAPI `Visibility` enum. Runtime DDL lives in `api/lib/schema.mysql.js`
-- and `api/lib/schema.sqlite.js` and MUST be kept in sync with this file.
-- ============================================================================

CREATE TABLE IF NOT EXISTS VIDEO_METADATA (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  original_upload_id BIGINT UNSIGNED NOT NULL,
  title              VARCHAR(255)    NOT NULL,
  description        TEXT            NULL,
  view_count         BIGINT UNSIGNED NOT NULL DEFAULT 0,
  visibility         VARCHAR(16)     NOT NULL DEFAULT 'private',
  comments_enabled   TINYINT(1)      NOT NULL DEFAULT 1,
  created_at         TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_video_metadata_upload (original_upload_id),
  CONSTRAINT fk_video_metadata_upload
    FOREIGN KEY (original_upload_id) REFERENCES ORIGINAL_UPLOADS (id) ON DELETE CASCADE,
  CONSTRAINT chk_video_metadata_visibility
    CHECK (visibility IN ('public','private','unlisted','hidden'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
