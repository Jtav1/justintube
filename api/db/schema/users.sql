-- ============================================================================
-- USERS
--
-- One row per user account. Local accounts authenticate with a bcrypt password
-- hash stored in `password_hash`; that column is nullable so SSO-only accounts
-- (linked through USER_IDENTITIES) can exist without a local password.
--
-- `username` and `email` are unique account identifiers. `display_name` is the
-- optional human-facing name and `bio` is a free-form profile blurb capped at
-- 5000 characters. `email_verified` / `email_verified_at` capture verification
-- state and when it happened. `uploader` is a boolean flag (1 = on, 0 = off,
-- defaulting to off) marking whether the account may upload videos.
-- `role_id` references ROLES(id) and is nullable so
-- registration can assign the default role in application code; it is set to
-- NULL if the referenced role is deleted. `created_at` / `updated_at` track the
-- account lifecycle. Runtime DDL lives in `api/lib/schema.mysql.js` and
-- `api/lib/schema.sqlite.js` and MUST be kept in sync with this file.
-- ============================================================================

CREATE TABLE IF NOT EXISTS USERS (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username          VARCHAR(255)    NOT NULL,
  email             VARCHAR(255)    NOT NULL,
  display_name      VARCHAR(255)    NULL,
  password_hash     VARCHAR(255)    NULL,
  bio               VARCHAR(5000)   NULL,
  email_verified    TINYINT(1)      NOT NULL DEFAULT 0,
  email_verified_at TIMESTAMP       NULL,
  uploader          TINYINT(1)      NOT NULL DEFAULT 0,
  role_id           BIGINT UNSIGNED NULL,
  created_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_role (role_id),
  CONSTRAINT fk_users_role
    FOREIGN KEY (role_id) REFERENCES ROLES (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
