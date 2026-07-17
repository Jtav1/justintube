-- ============================================================================
-- ROLES
--
-- The set of authorization roles a user account can hold (admin, moderator,
-- uploader, viewer, locked). Each row is a single role that USERS.role_id may
-- reference. The standard roles are seeded idempotently on startup by the
-- reference-data seeder (see `api/lib/schema.js`).
--
-- The UNIQUE key on `name` keeps role names distinct so they can be looked up
-- by name, `description` is a human-readable explanation, and `enabled` allows
-- a role to be turned off without deleting it. Runtime DDL lives in
-- `api/lib/schema.mysql.js` and `api/lib/schema.sqlite.js` and MUST be kept in
-- sync with this file.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ROLES (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(64)     NOT NULL,
  description VARCHAR(255)    NULL,
  enabled     TINYINT(1)      NOT NULL DEFAULT 1,
  created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_roles_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
