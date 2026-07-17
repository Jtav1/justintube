-- ============================================================================
-- USER_IDENTITIES
--
-- Links an internal USERS account to an external identity at an SSO provider.
-- Each row records that a given user authenticated as a specific subject at a
-- given provider. Both FKs cascade on delete so removing a user (or a provider)
-- cleans up the associated linked identities.
--
-- `provider_user_id` is the provider's stable subject/sub for the account.
-- `email` stores the address reported by the provider (nullable). The UNIQUE
-- key on (provider_id, provider_user_id) prevents the same external identity
-- from being linked twice, and the UNIQUE key on (user_id, provider_id) keeps a
-- user linked to at most one identity per provider. Runtime DDL lives in
-- `api/lib/schema.mysql.js` and `api/lib/schema.sqlite.js` and MUST be kept in
-- sync with this file.
-- ============================================================================

CREATE TABLE IF NOT EXISTS USER_IDENTITIES (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id          BIGINT UNSIGNED NOT NULL,
  provider_id      BIGINT UNSIGNED NOT NULL,
  provider_user_id VARCHAR(255)    NOT NULL,
  email            VARCHAR(255)    NULL,
  created_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_identities_provider_subject (provider_id, provider_user_id),
  UNIQUE KEY uq_user_identities_user_provider (user_id, provider_id),
  KEY idx_user_identities_user (user_id),
  CONSTRAINT fk_user_identities_user
    FOREIGN KEY (user_id) REFERENCES USERS (id) ON DELETE CASCADE,
  CONSTRAINT fk_user_identities_provider
    FOREIGN KEY (provider_id) REFERENCES SSO_PROVIDERS (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
