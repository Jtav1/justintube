import { randomUUID } from "node:crypto";
import { execute, query } from "../../lib/db.js";
import { ensureSchema } from "../../lib/schema.js";

/**
 * Tables that hold video-upload data, ordered so that children are deleted
 * before their parents (satisfying foreign-key constraints during a reset).
 *
 * @type {string[]}
 */
const TABLES_CHILD_FIRST = [
  "PLAYLIST_ITEMS",
  "FILE_VERSIONS",
  "VIDEO_METADATA",
  "VIDEO_LIKES",
  "CONTENT_TAGS",
  "FEATURED_VIDEOS",
  "USER_PLAYLISTS",
  "ORIGINAL_UPLOADS",
];

/**
 * Creates all application tables, columns, and views for the active (SQLite)
 * test database. Idempotent, so it is safe to call in every suite's `beforeAll`.
 *
 * @returns {Promise<void>} Resolves once the schema exists.
 */
export async function setupSchema() {
  await ensureSchema();
}

/**
 * Empties every video-upload table so each test starts from a clean slate.
 * Deletes children before parents to respect foreign keys.
 *
 * @returns {Promise<void>} Resolves once all rows have been removed.
 */
export async function resetTables() {
  for (const table of TABLES_CHILD_FIRST) {
    await execute(`DELETE FROM ${table}`);
  }
}

/**
 * Inserts a row into ORIGINAL_UPLOADS, filling sensible defaults for any field
 * the caller omits, and returns the new upload's id along with its values.
 *
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {string} [overrides.originalFilename] Client-provided filename.
 * @param {string} [overrides.uuidName] On-disk UUID filename (defaults to a fresh UUID).
 * @param {string} [overrides.fileExtension] Lowercase extension without a dot.
 * @param {string|null} [overrides.mimeType] MIME type of the upload.
 * @param {number|null} [overrides.fileSizeBytes] Size of the file in bytes.
 * @param {string} [overrides.storagePath] Relative on-disk path.
 * @param {string} [overrides.status] Lifecycle status label.
 * @param {string|null} [overrides.resolution] Normalized resolution label.
 * @param {number|null} [overrides.userId] Owning user id (nullable for now).
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded upload's id and values.
 */
export async function seedUpload(overrides = {}) {
  const record = {
    originalFilename: "sample.mp4",
    uuidName: randomUUID(),
    fileExtension: "mp4",
    mimeType: "video/mp4",
    fileSizeBytes: 2048,
    storagePath: `${randomUUID()}.mp4`,
    status: "uploaded",
    resolution: null,
    userId: null,
    ...overrides,
  };

  const result = await execute(
    `INSERT INTO ORIGINAL_UPLOADS
       (original_filename, uuid_name, file_extension, mime_type, file_size_bytes, storage_path, status, resolution, user_id)
     VALUES
       (:originalFilename, :uuidName, :fileExtension, :mimeType, :fileSizeBytes, :storagePath, :status, :resolution, :userId)`,
    record,
  );

  return { id: result.insertId, ...record };
}

/**
 * Inserts a VIDEO_METADATA row for an existing upload, applying defaults for any
 * omitted field.
 *
 * @param {number} originalUploadId Id of the parent ORIGINAL_UPLOADS row.
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {string} [overrides.title] Human-facing title.
 * @param {string|null} [overrides.description] Long-form description.
 * @param {number} [overrides.viewCount] Lifetime view count.
 * @param {string} [overrides.visibility] Visibility label.
 * @param {number} [overrides.commentsEnabled] 1 when comments are enabled, else 0.
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded metadata's id and values.
 */
export async function seedMetadata(originalUploadId, overrides = {}) {
  const record = {
    originalUploadId,
    title: "Sample title",
    description: null,
    viewCount: 0,
    visibility: "public",
    commentsEnabled: 1,
    ...overrides,
  };

  const result = await execute(
    `INSERT INTO VIDEO_METADATA
       (original_upload_id, title, description, view_count, visibility, comments_enabled)
     VALUES
       (:originalUploadId, :title, :description, :viewCount, :visibility, :commentsEnabled)`,
    record,
  );

  return { id: result.insertId, ...record };
}

/**
 * Inserts a USER_PLAYLISTS row, applying defaults for any omitted field.
 *
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {number|null} [overrides.userId] Owning user id (nullable for now).
 * @param {string} [overrides.title] Playlist title.
 * @param {string|null} [overrides.description] Playlist description.
 * @param {string} [overrides.visibility] Visibility label.
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded playlist's id and values.
 */
export async function seedPlaylist(overrides = {}) {
  const record = {
    userId: null,
    title: "Sample playlist",
    description: null,
    visibility: "private",
    ...overrides,
  };

  const result = await execute(
    `INSERT INTO USER_PLAYLISTS
       (user_id, title, description, visibility)
     VALUES
       (:userId, :title, :description, :visibility)`,
    record,
  );

  return { id: result.insertId, ...record };
}

/**
 * Inserts a FILE_VERSIONS row (a transcoded variant) for an existing upload.
 *
 * @param {number} originalUploadId Id of the parent ORIGINAL_UPLOADS row.
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {string} [overrides.uuidName] On-disk UUID filename (defaults to a fresh UUID).
 * @param {string} [overrides.fileExtension] Lowercase extension without a dot.
 * @param {string|null} [overrides.mimeType] MIME type of the variant.
 * @param {number|null} [overrides.fileSizeBytes] Size of the variant in bytes.
 * @param {string} [overrides.storagePath] Relative on-disk path.
 * @param {string} [overrides.status] Lifecycle status label.
 * @param {string|null} [overrides.resolution] Normalized resolution label.
 * @param {number|null} [overrides.transcodeProfileId] Producing transcode profile id.
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded variant's id and values.
 */
export async function seedFileVersion(originalUploadId, overrides = {}) {
  const record = {
    originalUploadId,
    uuidName: randomUUID(),
    fileExtension: "mp4",
    mimeType: "video/mp4",
    fileSizeBytes: 1024,
    storagePath: `${randomUUID()}.mp4`,
    status: "success",
    resolution: "720p",
    transcodeProfileId: 1,
    ...overrides,
  };

  const result = await execute(
    `INSERT INTO FILE_VERSIONS
       (original_upload_id, uuid_name, file_extension, mime_type, file_size_bytes, storage_path, status, resolution, transcode_profile_id)
     VALUES
       (:originalUploadId, :uuidName, :fileExtension, :mimeType, :fileSizeBytes, :storagePath, :status, :resolution, :transcodeProfileId)`,
    record,
  );

  return { id: result.insertId, ...record };
}

/**
 * Inserts a VIDEO_LIKES row (a user's like/dislike) for an existing upload,
 * applying defaults for any omitted field.
 *
 * @param {number} originalUploadId Id of the parent ORIGINAL_UPLOADS row.
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {number|null} [overrides.userId] Voting user id (nullable for now).
 * @param {number} [overrides.likeValue] 1 for a like, -1 for a dislike.
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded like's id and values.
 */
export async function seedVideoLike(originalUploadId, overrides = {}) {
  const record = {
    originalUploadId,
    userId: null,
    likeValue: 1,
    ...overrides,
  };

  const result = await execute(
    `INSERT INTO VIDEO_LIKES
       (original_upload_id, user_id, like_value)
     VALUES
       (:originalUploadId, :userId, :likeValue)`,
    record,
  );

  return { id: result.insertId, ...record };
}

/**
 * Inserts a CONTENT_TAGS row (a single tag) for an existing upload, applying
 * defaults for any omitted field.
 *
 * @param {number} originalUploadId Id of the parent ORIGINAL_UPLOADS row.
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {string} [overrides.tag] Tag string applied to the video.
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded tag's id and values.
 */
export async function seedContentTag(originalUploadId, overrides = {}) {
  const record = {
    originalUploadId,
    tag: "sample-tag",
    ...overrides,
  };

  const result = await execute(
    `INSERT INTO CONTENT_TAGS
       (original_upload_id, tag)
     VALUES
       (:originalUploadId, :tag)`,
    record,
  );

  return { id: result.insertId, ...record };
}

/**
 * Inserts a FEATURED_VIDEOS row promoting an existing upload.
 *
 * @param {number} originalUploadId Id of the featured ORIGINAL_UPLOADS row.
 * @returns {Promise<{id: number, originalUploadId: number}>} The seeded row's id and upload id.
 */
export async function seedFeaturedVideo(originalUploadId) {
  const result = await execute(
    `INSERT INTO FEATURED_VIDEOS (original_upload_id)
     VALUES (:originalUploadId)`,
    { originalUploadId },
  );

  return { id: result.insertId, originalUploadId };
}

/**
 * Convenience re-export of the raw read helper so suites can assert row state
 * without importing `lib/db.js` directly.
 *
 * @param {string} sql SQL statement, optionally with `:named` placeholders.
 * @param {object} [params] Values bound to the query placeholders.
 * @returns {Promise<Array<object>>} Resolves to the selected rows.
 */
export function queryRows(sql, params) {
  return query(sql, params);
}
