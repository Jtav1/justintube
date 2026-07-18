-- ============================================================================
-- STATIC_PAGES
--
-- One row per block of pre-rendered, HTML-formatted content shown on static
-- pages (e.g. About, Terms, Privacy). `description` is a short human-facing
-- label identifying the block, and `contents` holds the HTML markup rendered
-- into the page.
--
-- `contents` is capped below 10,000 characters via VARCHAR(9999). `created_at`
-- records when the block was added and `updated_at` tracks the last edit.
-- Runtime DDL lives in `api/lib/schema.mysql.js` and `api/lib/schema.sqlite.js`
-- and MUST be kept in sync with this file.
-- ============================================================================

CREATE TABLE IF NOT EXISTS STATIC_PAGES (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  description VARCHAR(255)    NOT NULL,
  contents    VARCHAR(9999)   NOT NULL,
  created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
