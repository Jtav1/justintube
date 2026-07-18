-- ============================================================================
-- NOTIFICATIONS
--
-- One row per notification delivered to a user. `user_id` is the target
-- recipient and references USERS(id), cascading on delete so a user's
-- notifications are removed with them.
--
-- `notification_type` is a free-form string reserved for a future categorized
-- set of types (nullable, no fixed values yet). `title` and `message` hold the
-- human-facing content. `created_at` records when the notification was raised
-- and `read_at` is NULL until the recipient reads it, at which point it stores
-- the read timestamp. Runtime DDL lives in `api/lib/schema.mysql.js` and
-- `api/lib/schema.sqlite.js` and MUST be kept in sync with this file.
-- ============================================================================

CREATE TABLE IF NOT EXISTS NOTIFICATIONS (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id           BIGINT UNSIGNED NOT NULL,
  notification_type VARCHAR(64)     NULL,
  title             VARCHAR(255)    NOT NULL,
  message           TEXT            NOT NULL,
  created_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at           TIMESTAMP       NULL,
  PRIMARY KEY (id),
  KEY idx_notifications_user (user_id),
  KEY idx_notifications_user_read (user_id, read_at),
  CONSTRAINT fk_notifications_user
    FOREIGN KEY (user_id) REFERENCES USERS (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
