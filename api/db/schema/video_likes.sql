-- ============================================================================
-- VIDEO_LIKES
--
-- Records a single user's like or dislike of a video. Each row ties a user to
-- an ORIGINAL_UPLOADS record along with a `like_value` of 1 (like) or -1
-- (dislike). The FK cascades on delete so removing an upload cleans up its
-- likes.
--
-- `user_id` is nullable but now references USERS(id) and cascades on delete, so
-- removing a user removes their likes. The column is named `like_value` rather
-- than `like` because LIKE is a reserved SQL keyword. The UNIQUE key on
-- (user_id, original_upload_id) keeps one vote per user per video. `created_at`
-- defaults to when the row was inserted. Runtime DDL lives in
-- `api/lib/schema.mysql.js` and `api/lib/schema.sqlite.js` and MUST be kept in
-- sync with this file.
-- ============================================================================

CREATE TABLE IF NOT EXISTS VIDEO_LIKES (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id            BIGINT UNSIGNED NULL,
  original_upload_id BIGINT UNSIGNED NOT NULL,
  like_value         TINYINT         NOT NULL,
  created_at         TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_video_likes_user_upload (user_id, original_upload_id),
  KEY idx_video_likes_upload (original_upload_id),
  KEY idx_video_likes_user (user_id),
  CONSTRAINT fk_video_likes_upload
    FOREIGN KEY (original_upload_id) REFERENCES ORIGINAL_UPLOADS (id) ON DELETE CASCADE,
  CONSTRAINT fk_video_likes_user
    FOREIGN KEY (user_id) REFERENCES USERS (id) ON DELETE CASCADE,
  CONSTRAINT chk_video_likes_value
    CHECK (like_value IN (-1, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
