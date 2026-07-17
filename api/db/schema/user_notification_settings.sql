-- ============================================================================
-- USER_NOTIFICATION_SETTINGS
--
-- Stores a user's per-type notification preferences. Each row ties a `user_id`
-- (references USERS(id), cascading on delete) to a `notification_type`, the
-- category the preference applies to.
--
-- `notification_type` is a free-form string reserved for a future categorized
-- set of types (nullable, no fixed values yet). `enabled` is a boolean flag
-- (1 = on, 0 = off) defaulting to on, so a row records whether the user wants
-- that type of notification delivered. The UNIQUE key on
-- (user_id, notification_type) keeps at most one row per user per type. Runtime
-- DDL lives in `api/lib/schema.mysql.js` and `api/lib/schema.sqlite.js` and MUST
-- be kept in sync with this file.
-- ============================================================================

CREATE TABLE IF NOT EXISTS USER_NOTIFICATION_SETTINGS (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id           BIGINT UNSIGNED NOT NULL,
  notification_type VARCHAR(64)     NULL,
  enabled           TINYINT(1)      NOT NULL DEFAULT 1,
  created_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_notification_settings_user_type (user_id, notification_type),
  KEY idx_user_notification_settings_user (user_id),
  CONSTRAINT fk_user_notification_settings_user
    FOREIGN KEY (user_id) REFERENCES USERS (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
