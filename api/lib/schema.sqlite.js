/**
 * SQLite DDL for the ROLES table. Holds the authorization roles a user account
 * can hold; the standard roles are seeded on startup. Kept in sync with
 * `api/db/schema/roles.sql` and the MySQL definition in `api/lib/schema.mysql.js`.
 *
 * @type {string}
 */
export const ROLES_DDL = `
  CREATE TABLE IF NOT EXISTS ROLES (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    description TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

/**
 * SQLite DDL for the USERS table. One row per account; local accounts store a
 * bcrypt hash in `password_hash` (nullable for SSO-only accounts). Kept in sync
 * with `api/db/schema/users.sql` and the MySQL definition in
 * `api/lib/schema.mysql.js`.
 *
 * @type {string}
 */
export const USERS_DDL = `
  CREATE TABLE IF NOT EXISTS USERS (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    username          TEXT    NOT NULL UNIQUE,
    email             TEXT    NOT NULL UNIQUE,
    display_name      TEXT,
    password_hash     TEXT,
    bio               TEXT,
    email_verified    INTEGER NOT NULL DEFAULT 0,
    email_verified_at TEXT,
    role_id           INTEGER,
    created_at        TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (role_id) REFERENCES ROLES (id) ON DELETE SET NULL
  )
`;

/**
 * SQLite DDL for the SSO_PROVIDERS table. Catalog of single sign-on providers
 * that users can link an external identity to. Kept in sync with
 * `api/db/schema/sso_providers.sql` and the MySQL definition in
 * `api/lib/schema.mysql.js`.
 *
 * @type {string}
 */
export const SSO_PROVIDERS_DDL = `
  CREATE TABLE IF NOT EXISTS SSO_PROVIDERS (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_key TEXT    NOT NULL UNIQUE,
    name         TEXT    NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

/**
 * SQLite DDL for the USER_IDENTITIES table. Links an internal USERS account to
 * an external identity at an SSO provider. Kept in sync with
 * `api/db/schema/user_identities.sql` and the MySQL definition in
 * `api/lib/schema.mysql.js`.
 *
 * @type {string}
 */
export const USER_IDENTITIES_DDL = `
  CREATE TABLE IF NOT EXISTS USER_IDENTITIES (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL,
    provider_id      INTEGER NOT NULL,
    provider_user_id TEXT    NOT NULL,
    email            TEXT,
    created_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (provider_id, provider_user_id),
    UNIQUE (user_id, provider_id),
    FOREIGN KEY (user_id) REFERENCES USERS (id) ON DELETE CASCADE,
    FOREIGN KEY (provider_id) REFERENCES SSO_PROVIDERS (id) ON DELETE CASCADE
  )
`;

/**
 * SQLite DDL for the ORIGINAL_UPLOADS table (local dev). Kept in sync with the
 * master schema reference in `api/db/schema/original_uploads.sql` and mirrors
 * the MySQL definition in `api/lib/schema.mysql.js` using SQLite-compatible
 * types.
 *
 * @type {string}
 */
export const ORIGINAL_UPLOADS_DDL = `
  CREATE TABLE IF NOT EXISTS ORIGINAL_UPLOADS (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    original_filename TEXT    NOT NULL,
    uuid_name         TEXT    NOT NULL UNIQUE,
    file_extension    TEXT    NOT NULL,
    mime_type         TEXT,
    file_size_bytes   INTEGER,
    storage_path      TEXT    NOT NULL,
    status            TEXT    NOT NULL DEFAULT 'uploaded',
    video_width       INTEGER,
    video_height      INTEGER,
    resolution        TEXT    CHECK (resolution IN ('240p','360p','480p','720p','1080p','2kHD','4kHD')),
    user_id           INTEGER,
    uploaded_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES USERS (id) ON DELETE SET NULL
  )
`;

/**
 * SQLite DDL for the VIDEO_METADATA table. Holds the screen-viewable metadata for
 * a single upload (one row per ORIGINAL_UPLOADS record).
 *
 * @type {string}
 */
export const VIDEO_METADATA_DDL = `
  CREATE TABLE IF NOT EXISTS VIDEO_METADATA (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    original_upload_id INTEGER NOT NULL UNIQUE,
    title              TEXT    NOT NULL,
    description        TEXT,
    view_count         INTEGER NOT NULL DEFAULT 0,
    visibility         TEXT    NOT NULL DEFAULT 'private'
      CHECK (visibility IN ('public','private','unlisted','hidden')),
    comments_enabled   INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (original_upload_id) REFERENCES ORIGINAL_UPLOADS (id) ON DELETE CASCADE
  )
`;

/**
 * SQLite DDL for the FILE_VERSIONS table. Stores transcoded copies of an upload,
 * mirroring ORIGINAL_UPLOADS but keyed to a transcode profile instead of a user.
 *
 * @type {string}
 */
export const FILE_VERSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS FILE_VERSIONS (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    original_upload_id   INTEGER NOT NULL,
    uuid_name            TEXT    NOT NULL UNIQUE,
    file_extension       TEXT    NOT NULL,
    mime_type            TEXT,
    file_size_bytes      INTEGER,
    storage_path         TEXT    NOT NULL,
    status               TEXT    NOT NULL DEFAULT 'pending',
    video_width          INTEGER,
    video_height         INTEGER,
    resolution           TEXT    CHECK (resolution IN ('240p','360p','480p','720p','1080p','2kHD','4kHD')),
    transcode_profile_id INTEGER,
    created_at           TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (original_upload_id, transcode_profile_id),
    FOREIGN KEY (original_upload_id) REFERENCES ORIGINAL_UPLOADS (id) ON DELETE CASCADE
  )
`;

/**
 * SQLite DDL for the USER_PLAYLISTS table. Stores playlists owned by a user; the
 * owning `user_id` references a future users table and is not FK-enforced yet.
 *
 * @type {string}
 */
export const USER_PLAYLISTS_DDL = `
  CREATE TABLE IF NOT EXISTS USER_PLAYLISTS (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER,
    title         TEXT    NOT NULL,
    description   TEXT,
    visibility    TEXT    NOT NULL DEFAULT 'private'
      CHECK (visibility IN ('public','private','unlisted','hidden')),
    created_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_added_at TEXT,
    updated_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES USERS (id) ON DELETE CASCADE
  )
`;

/**
 * SQLite DDL for the PLAYLIST_ITEMS table. Join table linking playlists to the
 * original uploads they contain.
 *
 * @type {string}
 */
export const PLAYLIST_ITEMS_DDL = `
  CREATE TABLE IF NOT EXISTS PLAYLIST_ITEMS (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id        INTEGER NOT NULL,
    original_upload_id INTEGER NOT NULL,
    position           INTEGER,
    added_at           TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (playlist_id, original_upload_id),
    FOREIGN KEY (playlist_id) REFERENCES USER_PLAYLISTS (id) ON DELETE CASCADE,
    FOREIGN KEY (original_upload_id) REFERENCES ORIGINAL_UPLOADS (id) ON DELETE CASCADE
  )
`;

/**
 * SQLite DDL for the VIDEO_LIKES table. Records a single user's like (1) or
 * dislike (-1) of an upload; `user_id` references a future users table and is
 * not FK-enforced yet.
 *
 * @type {string}
 */
export const VIDEO_LIKES_DDL = `
  CREATE TABLE IF NOT EXISTS VIDEO_LIKES (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id            INTEGER,
    original_upload_id INTEGER NOT NULL,
    like_value         INTEGER NOT NULL CHECK (like_value IN (-1, 1)),
    created_at         TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, original_upload_id),
    FOREIGN KEY (original_upload_id) REFERENCES ORIGINAL_UPLOADS (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES USERS (id) ON DELETE CASCADE
  )
`;

/**
 * SQLite DDL for the CONTENT_TAGS table. Stores one row per tag applied to an
 * upload; unique per (upload, tag) so a tag is not duplicated on a video.
 *
 * @type {string}
 */
export const CONTENT_TAGS_DDL = `
  CREATE TABLE IF NOT EXISTS CONTENT_TAGS (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    original_upload_id INTEGER NOT NULL,
    tag                TEXT    NOT NULL,
    created_at         TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (original_upload_id, tag),
    FOREIGN KEY (original_upload_id) REFERENCES ORIGINAL_UPLOADS (id) ON DELETE CASCADE
  )
`;

/**
 * SQLite DDL for the FEATURED_VIDEOS table. The curated set of uploads promoted
 * in the featured carousel, unique per upload so a video is featured at most
 * once.
 *
 * @type {string}
 */
export const FEATURED_VIDEOS_DDL = `
  CREATE TABLE IF NOT EXISTS FEATURED_VIDEOS (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    original_upload_id INTEGER NOT NULL UNIQUE,
    created_at         TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (original_upload_id) REFERENCES ORIGINAL_UPLOADS (id) ON DELETE CASCADE
  )
`;

/**
 * SQLite DDL for the USER_VIDEOS view. Lists each owning user_id alongside the
 * videos they own, joining screen-viewable metadata when present. Uses
 * CREATE VIEW IF NOT EXISTS (SQLite has no CREATE OR REPLACE VIEW).
 *
 * @type {string}
 */
export const USER_VIDEOS_VIEW_DDL = `
  CREATE VIEW IF NOT EXISTS USER_VIDEOS AS
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
 * All table DDL statements required to build the SQLite schema, in execution
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
];

/**
 * View DDL statements, run after tables (and column migrations) so referenced
 * columns exist.
 *
 * @type {string[]}
 */
export const VIEW_STATEMENTS = [USER_VIDEOS_VIEW_DDL];
