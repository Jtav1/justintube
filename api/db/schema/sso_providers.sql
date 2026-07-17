-- ============================================================================
-- SSO_PROVIDERS
--
-- The catalog of single sign-on providers the application can authenticate
-- against (e.g. Google, GitHub). Each row describes one provider that users can
-- link an external identity to through USER_IDENTITIES.
--
-- `provider_key` is the stable machine slug (e.g. 'google') used in URLs and
-- lookups and is unique; `name` is the human-facing label shown on login
-- buttons; `enabled` toggles the provider without deleting it. `created_at` /
-- `updated_at` track the row lifecycle. Runtime DDL lives in
-- `api/lib/schema.mysql.js` and `api/lib/schema.sqlite.js` and MUST be kept in
-- sync with this file.
-- ============================================================================

CREATE TABLE IF NOT EXISTS SSO_PROVIDERS (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider_key VARCHAR(64)     NOT NULL,
  name         VARCHAR(255)    NOT NULL,
  enabled      TINYINT(1)      NOT NULL DEFAULT 1,
  created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sso_providers_key (provider_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
