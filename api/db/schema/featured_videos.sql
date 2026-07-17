-- ============================================================================
-- FEATURED_VIDEOS
--
-- The curated set of videos promoted in the featured carousel. Each row points
-- at one original upload (ORIGINAL_UPLOADS) and records when it was featured.
-- The FK cascades on delete so removing an upload also removes it from the
-- featured list.
--
-- The UNIQUE key on original_upload_id keeps a video featured at most once, and
-- `created_at` defaults to when the row was inserted. Runtime DDL lives in
-- `api/lib/schema.mysql.js` and `api/lib/schema.sqlite.js` and MUST be kept in
-- sync with this file.
-- ============================================================================

CREATE TABLE IF NOT EXISTS FEATURED_VIDEOS (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  original_upload_id BIGINT UNSIGNED NOT NULL,
  created_at         TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_featured_videos_upload (original_upload_id),
  CONSTRAINT fk_featured_videos_upload
    FOREIGN KEY (original_upload_id) REFERENCES ORIGINAL_UPLOADS (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
