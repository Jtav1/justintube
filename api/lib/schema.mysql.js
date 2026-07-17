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
  ORIGINAL_UPLOADS_DDL,
  VIDEO_METADATA_DDL,
  FILE_VERSIONS_DDL,
  USER_PLAYLISTS_DDL,
  PLAYLIST_ITEMS_DDL,
];

/**
 * View DDL statements, run after tables (and column migrations) so referenced
 * columns exist.
 *
 * @type {string[]}
 */
export const VIEW_STATEMENTS = [USER_VIDEOS_VIEW_DDL];
