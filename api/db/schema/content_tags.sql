-- ============================================================================
-- CONTENT_TAGS
--
-- Stores the free-form tags applied to a video. Each row is one tag string tied
-- to an ORIGINAL_UPLOADS record, so a video with several tags has several rows.
-- The FK cascades on delete so removing an upload cleans up its tags.
--
-- The UNIQUE key on (original_upload_id, tag) prevents adding the same tag to a
-- video twice, and idx_content_tags_tag supports lookups/search by tag string.
-- `created_at` defaults to when the row was inserted. Runtime DDL lives in
-- `api/lib/schema.mysql.js` and `api/lib/schema.sqlite.js` and MUST be kept in
-- sync with this file.
-- ============================================================================

CREATE TABLE IF NOT EXISTS CONTENT_TAGS (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  original_upload_id BIGINT UNSIGNED NOT NULL,
  tag                VARCHAR(255)    NOT NULL,
  created_at         TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_content_tags_upload_tag (original_upload_id, tag),
  KEY idx_content_tags_tag (tag),
  CONSTRAINT fk_content_tags_upload
    FOREIGN KEY (original_upload_id) REFERENCES ORIGINAL_UPLOADS (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
