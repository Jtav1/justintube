/**
 * MySQL DDL for the ROLES table. Holds the authorization roles a user account
 * can hold; the standard roles are seeded on startup. Kept in sync with
 * `api/db/schema/roles.sql` and the SQLite variant in `api/lib/schema.sqlite.js`.
 *
 * @type {string}
 */
export const ROLES_DDL = `
  CREATE TABLE IF NOT EXISTS ROLES (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name        VARCHAR(64)     NOT NULL,
    description VARCHAR(255)    NULL,
    enabled     TINYINT(1)      NOT NULL DEFAULT 1,
    created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_roles_name (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * MySQL DDL for the USERS table. One row per account; local accounts store a
 * bcrypt hash in `password_hash` (nullable for SSO-only accounts). Kept in sync
 * with `api/db/schema/users.sql` and the SQLite variant in
 * `api/lib/schema.sqlite.js`.
 *
 * @type {string}
 */
export const USERS_DDL = `
  CREATE TABLE IF NOT EXISTS USERS (
    id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    username          VARCHAR(255)    NOT NULL,
    email             VARCHAR(255)    NOT NULL,
    display_name      VARCHAR(255)    NULL,
    password_hash     VARCHAR(255)    NULL,
    bio               VARCHAR(5000)   NULL,
    email_verified    TINYINT(1)      NOT NULL DEFAULT 0,
    email_verified_at TIMESTAMP       NULL,
    role_id           BIGINT UNSIGNED NULL,
    created_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_username (username),
    UNIQUE KEY uq_users_email (email),
    KEY idx_users_role (role_id),
    CONSTRAINT fk_users_role
      FOREIGN KEY (role_id) REFERENCES ROLES (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * MySQL DDL for the SSO_PROVIDERS table. Catalog of single sign-on providers
 * that users can link an external identity to. Kept in sync with
 * `api/db/schema/sso_providers.sql` and the SQLite variant in
 * `api/lib/schema.sqlite.js`.
 *
 * @type {string}
 */
export const SSO_PROVIDERS_DDL = `
  CREATE TABLE IF NOT EXISTS SSO_PROVIDERS (
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    provider_key VARCHAR(64)     NOT NULL,
    name         VARCHAR(255)    NOT NULL,
    enabled      TINYINT(1)      NOT NULL DEFAULT 1,
    created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_sso_providers_key (provider_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * MySQL DDL for the USER_IDENTITIES table. Links an internal USERS account to an
 * external identity at an SSO provider. Kept in sync with
 * `api/db/schema/user_identities.sql` and the SQLite variant in
 * `api/lib/schema.sqlite.js`.
 *
 * @type {string}
 */
export const USER_IDENTITIES_DDL = `
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * MySQL DDL for the ORIGINAL_UPLOADS table. Kept in sync with the master schema
 * reference in `api/db/schema/original_uploads.sql` and the SQLite variant in
 * `api/lib/schema.sqlite.js`.
 *
 * @type {string}
 */
export const ORIGINAL_UPLOADS_DDL = `
  CREATE TABLE IF NOT EXISTS ORIGINAL_UPLOADS (
    id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    original_filename VARCHAR(255)    NOT NULL,
    uuid_name         CHAR(36)        NOT NULL,
    file_extension    VARCHAR(16)     NOT NULL,
    mime_type         VARCHAR(128)    NULL,
    file_size_bytes   BIGINT UNSIGNED NULL,
    storage_path      VARCHAR(512)    NOT NULL,
    status            VARCHAR(32)     NOT NULL DEFAULT 'uploaded',
    video_width       INT UNSIGNED    NULL,
    video_height      INT UNSIGNED    NULL,
    resolution        VARCHAR(16)     NULL,
    user_id           BIGINT UNSIGNED NULL,
    uploaded_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_uuid_name (uuid_name),
    KEY idx_original_uploads_user (user_id),
    CONSTRAINT fk_original_uploads_user
      FOREIGN KEY (user_id) REFERENCES USERS (id) ON DELETE SET NULL,
    CONSTRAINT chk_original_uploads_resolution
      CHECK (resolution IN ('240p','360p','480p','720p','1080p','2kHD','4kHD'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * MySQL DDL for the VIDEO_METADATA table. Holds the screen-viewable metadata for
 * a single upload (one row per ORIGINAL_UPLOADS record).
 *
 * @type {string}
 */
export const VIDEO_METADATA_DDL = `
  CREATE TABLE IF NOT EXISTS VIDEO_METADATA (
    id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    original_upload_id BIGINT UNSIGNED NOT NULL,
    title              VARCHAR(255)    NOT NULL,
    description        TEXT            NULL,
    view_count         BIGINT UNSIGNED NOT NULL DEFAULT 0,
    visibility         VARCHAR(16)     NOT NULL DEFAULT 'private',
    comments_enabled   TINYINT(1)      NOT NULL DEFAULT 1,
    created_at         TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_video_metadata_upload (original_upload_id),
    CONSTRAINT fk_video_metadata_upload
      FOREIGN KEY (original_upload_id) REFERENCES ORIGINAL_UPLOADS (id) ON DELETE CASCADE,
    CONSTRAINT chk_video_metadata_visibility
      CHECK (visibility IN ('public','private','unlisted','hidden'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * MySQL DDL for the FILE_VERSIONS table. Stores transcoded copies of an upload,
 * mirroring ORIGINAL_UPLOADS but keyed to a transcode profile instead of a user.
 *
 * @type {string}
 */
export const FILE_VERSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS FILE_VERSIONS (
    id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    original_upload_id   BIGINT UNSIGNED NOT NULL,
    uuid_name            CHAR(36)        NOT NULL,
    file_extension       VARCHAR(16)     NOT NULL,
    mime_type            VARCHAR(128)    NULL,
    file_size_bytes      BIGINT UNSIGNED NULL,
    storage_path         VARCHAR(512)    NOT NULL,
    status               VARCHAR(32)     NOT NULL DEFAULT 'pending',
    video_width          INT UNSIGNED    NULL,
    video_height         INT UNSIGNED    NULL,
    resolution           VARCHAR(16)     NULL,
    transcode_profile_id BIGINT UNSIGNED NULL,
    created_at           TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_file_versions_uuid (uuid_name),
    UNIQUE KEY uq_file_versions_variant (original_upload_id, transcode_profile_id),
    KEY idx_file_versions_upload (original_upload_id),
    CONSTRAINT fk_file_versions_upload
      FOREIGN KEY (original_upload_id) REFERENCES ORIGINAL_UPLOADS (id) ON DELETE CASCADE,
    CONSTRAINT chk_file_versions_resolution
      CHECK (resolution IN ('240p','360p','480p','720p','1080p','2kHD','4kHD'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * MySQL DDL for the USER_PLAYLISTS table. Stores playlists owned by a user; the
 * owning `user_id` references a future users table and is not FK-enforced yet.
 *
 * @type {string}
 */
export const USER_PLAYLISTS_DDL = `
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
    CONSTRAINT fk_user_playlists_user
      FOREIGN KEY (user_id) REFERENCES USERS (id) ON DELETE CASCADE,
    CONSTRAINT chk_user_playlists_visibility
      CHECK (visibility IN ('public','private','unlisted','hidden'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * MySQL DDL for the PLAYLIST_ITEMS table. Join table linking playlists to the
 * original uploads they contain.
 *
 * @type {string}
 */
export const PLAYLIST_ITEMS_DDL = `
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * MySQL DDL for the VIDEO_LIKES table. Records a single user's like (1) or
 * dislike (-1) of an upload; `user_id` references a future users table and is
 * not FK-enforced yet.
 *
 * @type {string}
 */
export const VIDEO_LIKES_DDL = `
  CREATE TABLE IF NOT EXISTS VIDEO_LIKES (
    id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id            BIGINT UNSIGNED NULL,
    original_upload_id BIGINT UNSIGNED NOT NULL,
    like_value         TINYINT         NOT NULL,
    created_at         TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_video_likes_user_upload (user_id, original_upload_id),
    KEY idx_video_likes_upload (original_upload_id),
    KEY idx_video_likes_user (user_id),
    CONSTRAINT fk_video_likes_upload
      FOREIGN KEY (original_upload_id) REFERENCES ORIGINAL_UPLOADS (id) ON DELETE CASCADE,
    CONSTRAINT fk_video_likes_user
      FOREIGN KEY (user_id) REFERENCES USERS (id) ON DELETE CASCADE,
    CONSTRAINT chk_video_likes_value
      CHECK (like_value IN (-1, 1))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * MySQL DDL for the CONTENT_TAGS table. Stores one row per tag applied to an
 * upload; unique per (upload, tag) so a tag is not duplicated on a video.
 *
 * @type {string}
 */
export const CONTENT_TAGS_DDL = `
  CREATE TABLE IF NOT EXISTS CONTENT_TAGS (
    id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    original_upload_id BIGINT UNSIGNED NOT NULL,
    tag                VARCHAR(255)    NOT NULL,
    created_at         TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_content_tags_upload_tag (original_upload_id, tag),
    KEY idx_content_tags_tag (tag),
    CONSTRAINT fk_content_tags_upload
      FOREIGN KEY (original_upload_id) REFERENCES ORIGINAL_UPLOADS (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * MySQL DDL for the FEATURED_VIDEOS table. The curated set of uploads promoted
 * in the featured carousel, unique per upload so a video is featured at most
 * once.
 *
 * @type {string}
 */
export const FEATURED_VIDEOS_DDL = `
  CREATE TABLE IF NOT EXISTS FEATURED_VIDEOS (
    id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    original_upload_id BIGINT UNSIGNED NOT NULL,
    created_at         TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_featured_videos_upload (original_upload_id),
    CONSTRAINT fk_featured_videos_upload
      FOREIGN KEY (original_upload_id) REFERENCES ORIGINAL_UPLOADS (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * MySQL DDL for the SUBSCRIPTIONS table. Records that one user (subscriber_id)
 * has subscribed to another user's content (subscribed_to_id). Kept in sync with
 * `api/db/schema/subscriptions.sql` and the SQLite variant in
 * `api/lib/schema.sqlite.js`.
 *
 * @type {string}
 */
export const SUBSCRIPTIONS_DDL = `
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * MySQL DDL for the NOTIFICATIONS table. One row per notification delivered to a
 * target user; `notification_type` is a free-form string reserved for future
 * use and `read_at` is NULL until the notification is read. Kept in sync with
 * `api/db/schema/notifications.sql` and the SQLite variant in
 * `api/lib/schema.sqlite.js`.
 *
 * @type {string}
 */
export const NOTIFICATIONS_DDL = `
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * MySQL DDL for the USER_NOTIFICATION_SETTINGS table. Stores a user's per-type
 * notification preferences; `notification_type` is a free-form string reserved
 * for future use. Kept in sync with
 * `api/db/schema/user_notification_settings.sql` and the SQLite variant in
 * `api/lib/schema.sqlite.js`.
 *
 * @type {string}
 */
export const USER_NOTIFICATION_SETTINGS_DDL = `
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * MySQL DDL for the USER_VIDEOS view. Lists each owning user_id alongside the
 * videos they own, joining screen-viewable metadata when present. Uses
 * CREATE OR REPLACE so the definition stays current across restarts.
 *
 * @type {string}
 */
export const USER_VIDEOS_VIEW_DDL = `
  CREATE OR REPLACE VIEW USER_VIDEOS AS
  SELECT
    ou.user_id           AS user_id,
    ou.id                AS video_id,
    ou.uuid_name         AS uuid_name,
    ou.original_filename AS original_filename,
    ou.status            AS status,
    ou.resolution        AS resolution,
    ou.uploaded_at       AS uploaded_at,
    vm.title             AS title,
    vm.visibility        AS visibility,
    vm.view_count        AS view_count,
    vm.comments_enabled  AS comments_enabled
  FROM ORIGINAL_UPLOADS ou
  LEFT JOIN VIDEO_METADATA vm ON vm.original_upload_id = ou.id
`;

/**
 * All table DDL statements required to build the MySQL schema, in execution
 * order (parents before children so foreign keys resolve).
 *
 * @type {string[]}
 */
export const SCHEMA_STATEMENTS = [
  ROLES_DDL,
  USERS_DDL,
  SSO_PROVIDERS_DDL,
  USER_IDENTITIES_DDL,
  ORIGINAL_UPLOADS_DDL,
  VIDEO_METADATA_DDL,
  FILE_VERSIONS_DDL,
  USER_PLAYLISTS_DDL,
  PLAYLIST_ITEMS_DDL,
  VIDEO_LIKES_DDL,
  CONTENT_TAGS_DDL,
  FEATURED_VIDEOS_DDL,
  SUBSCRIPTIONS_DDL,
  NOTIFICATIONS_DDL,
  USER_NOTIFICATION_SETTINGS_DDL,
];

/**
 * View DDL statements, run after tables (and column migrations) so referenced
 * columns exist.
 *
 * @type {string[]}
 */
export const VIEW_STATEMENTS = [USER_VIDEOS_VIEW_DDL];
