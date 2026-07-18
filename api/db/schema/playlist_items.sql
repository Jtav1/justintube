-- ============================================================================
-- PLAYLIST_ITEMS
--
-- Join table linking playlists (USER_PLAYLISTS) to the original uploads
-- (ORIGINAL_UPLOADS) they contain. Both foreign keys cascade on delete so
-- removing a playlist or an upload cleans up its membership rows.
--
-- `position` is an optional explicit ordering hint within the playlist, and the
-- UNIQUE key on (playlist_id, original_upload_id) prevents adding the same video
-- to a playlist twice. Runtime DDL lives in `api/lib/schema.mysql.js` and
-- `api/lib/schema.sqlite.js` and MUST be kept in sync with this file.
-- ============================================================================

CREATE TABLE IF NOT EXISTS PLAYLIST_ITEMS (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  playlist_id        BIGINT UNSIGNED NOT NULL,
  original_upload_id BIGINT UNSIGNED NOT NULL,
  position           INT UNSIGNED    NULL,
  added_at           TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_playlist_items (playlist_id, original_upload_id),
  KEY idx_playlist_items_upload (original_upload_id),
  CONSTRAINT fk_playlist_items_playlist
    FOREIGN KEY (playlist_id) REFERENCES USER_PLAYLISTS (id) ON DELETE CASCADE,
  CONSTRAINT fk_playlist_items_upload
    FOREIGN KEY (original_upload_id) REFERENCES ORIGINAL_UPLOADS (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
