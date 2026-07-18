-- ============================================================================
-- SUBSCRIPTIONS
--
-- Records that one user has subscribed to another user's content. Each row ties
-- a `subscriber_id` (the follower) to a `subscribed_to_id` (the followed
-- account) along with `created_at`, the date of subscription. Both FKs cascade
-- on delete so removing either user removes the subscription.
--
-- The UNIQUE key on (subscriber_id, subscribed_to_id) keeps at most one active
-- subscription per pair, and the CHECK prevents a user from subscribing to
-- themselves. Runtime DDL lives in `api/lib/schema.mysql.js` and
-- `api/lib/schema.sqlite.js` and MUST be kept in sync with this file.
-- ============================================================================

CREATE TABLE IF NOT EXISTS SUBSCRIPTIONS (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  subscriber_id    BIGINT UNSIGNED NOT NULL,
  subscribed_to_id BIGINT UNSIGNED NOT NULL,
  created_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_subscriptions_pair (subscriber_id, subscribed_to_id),
  KEY idx_subscriptions_subscriber (subscriber_id),
  KEY idx_subscriptions_subscribed_to (subscribed_to_id),
  CONSTRAINT fk_subscriptions_subscriber
    FOREIGN KEY (subscriber_id) REFERENCES USERS (id) ON DELETE CASCADE,
  CONSTRAINT fk_subscriptions_subscribed_to
    FOREIGN KEY (subscribed_to_id) REFERENCES USERS (id) ON DELETE CASCADE,
  CONSTRAINT chk_subscriptions_not_self
    CHECK (subscriber_id <> subscribed_to_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
