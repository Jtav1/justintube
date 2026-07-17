-- ============================================================================
-- USER_PLAYLISTS
--
-- A playlist owned by a user. `user_id` references a future users table and is
-- intentionally left nullable and NOT FK-enforced for now (that table does not
-- exist yet), mirroring the ORIGINAL_UPLOADS.user_id treatment.
--
-- `created_at` records when the playlist was created and `last_added_at` tracks
-- when an item was most recently added (nullable until the first item is
-- added). `visibility` is constrained to the shared set of visibility values,
-- matching the OpenAPI `Visibility` enum. Runtime DDL lives in
-- `api/lib/schema.mysql.js` and `api/lib/schema.sqlite.js` and MUST be kept in
-- sync with this file.
-- ============================================================================

CREATE TABLE IF NOT EXISTS USER_PLAYLISTS (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       BIGINT UNSIGNED NULL,
  title         VARCHAR(255)    NOT NULL,
  description   TEXT            NULL,
  visibility    VARCHAR(16)     NOT NULL DEFAULT 'private',
  created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_added_at TIMESTAMP       NULL,
  updated_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_user_playlists_user (user_id),
  CONSTRAINT chk_user_playlists_visibility
    CHECK (visibility IN ('public','private','unlisted','hidden'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
