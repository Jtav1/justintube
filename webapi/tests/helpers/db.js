import { randomUUID } from "node:crypto";
import { query } from "../../lib/db.js";
import {
  ContentTag,
  FeaturedVideo,
  FileVersion,
  Notification,
  OriginalUpload,
  PlaylistItem,
  Role,
  SsoProvider,
  StaticPage,
  Subscription,
  User,
  UserIdentity,
  UserNotificationSetting,
  UserPlaylist,
  VideoLike,
  VideoMetadata,
} from "../../lib/models/index.js";
import { ensureSchema } from "../../lib/schema.js";

/**
 * Models that hold per-test data, ordered so that children are deleted before
 * their parents (satisfying foreign-key constraints during a reset). Role is
 * intentionally omitted so the reference roles seeded by `ensureSchema` survive
 * across resets and remain available for `seedUser`.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>[]}
 */
const RESET_MODELS = [
  PlaylistItem,
  FileVersion,
  VideoMetadata,
  VideoLike,
  ContentTag,
  FeaturedVideo,
  UserPlaylist,
  OriginalUpload,
  Subscription,
  Notification,
  UserNotificationSetting,
  UserIdentity,
  User,
  SsoProvider,
  StaticPage,
];

/**
 * Creates all application tables and columns for the active (SQLite) test
 * database. Idempotent, so it is safe to call in every suite's `beforeAll`.
 *
 * @returns {Promise<void>} Resolves once the schema exists.
 */
export async function setupSchema() {
  await ensureSchema();
}

/**
 * Empties every mutable table so each test starts from a clean slate. Deletes
 * children before parents to respect foreign keys. Does not wipe ROLES.
 *
 * @returns {Promise<void>} Resolves once all rows have been removed.
 */
export async function resetTables() {
  for (const model of RESET_MODELS) {
    await model.destroy({ where: {}, force: true });
  }
}

/**
 * Converts a Sequelize model instance into a plain object with camelCase keys
 * matching the seed helper return shape (id plus input fields).
 *
 * @param {import('sequelize').Model} instance Created model instance.
 * @param {object} record Input values merged into the return payload.
 * @returns {{id: number} & Record<string, unknown>} Plain seeded record.
 */
function asSeedResult(instance, record) {
  return { id: instance.id, ...record };
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

  const row = await OriginalUpload.create(record);
  return asSeedResult(row, record);
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
 * @param {number|boolean} [overrides.commentsEnabled] Whether comments are enabled.
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded metadata's id and values.
 */
export async function seedMetadata(originalUploadId, overrides = {}) {
  const record = {
    originalUploadId,
    title: "Sample title",
    description: null,
    viewCount: 0,
    visibility: "public",
    commentsEnabled: true,
    ...overrides,
  };

  const row = await VideoMetadata.create(record);
  return asSeedResult(row, record);
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

  const row = await UserPlaylist.create(record);
  return asSeedResult(row, record);
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

  const row = await FileVersion.create(record);
  return asSeedResult(row, record);
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

  const row = await VideoLike.create(record);
  return asSeedResult(row, record);
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

  const row = await ContentTag.create(record);
  return asSeedResult(row, record);
}

/**
 * Inserts a FEATURED_VIDEOS row promoting an existing upload.
 *
 * @param {number} originalUploadId Id of the featured ORIGINAL_UPLOADS row.
 * @returns {Promise<{id: number, originalUploadId: number}>} The seeded row's id and upload id.
 */
export async function seedFeaturedVideo(originalUploadId) {
  const row = await FeaturedVideo.create({ originalUploadId });
  return { id: row.id, originalUploadId };
}

/**
 * Inserts a USERS row, filling sensible unique defaults for any field the caller
 * omits. When `roleId` is not provided it resolves to the seeded `viewer` role
 * so the ROLES foreign key is satisfied.
 *
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {string} [overrides.username] Unique account username.
 * @param {string} [overrides.email] Unique account email.
 * @param {string|null} [overrides.displayName] Human-facing display name.
 * @param {string|null} [overrides.passwordHash] Bcrypt password hash (nullable for SSO-only).
 * @param {string|null} [overrides.bio] Free-form profile blurb.
 * @param {number|boolean} [overrides.emailVerified] Whether the email is verified.
 * @param {string|null} [overrides.emailVerifiedAt] Timestamp of verification.
 * @param {number|boolean} [overrides.uploader] Whether the account may upload videos.
 * @param {number|null} [overrides.roleId] Role id (defaults to the seeded viewer role).
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded user's id and values.
 */
export async function seedUser(overrides = {}) {
  const suffix = randomUUID().slice(0, 8);
  const record = {
    username: `user_${suffix}`,
    email: `${suffix}@example.com`,
    displayName: null,
    passwordHash: null,
    bio: null,
    emailVerified: false,
    emailVerifiedAt: null,
    uploader: false,
    roleId: undefined,
    ...overrides,
  };

  if (record.roleId === undefined) {
    const viewer = await Role.findOne({ where: { name: "viewer" } });
    record.roleId = viewer ? viewer.id : null;
  }

  const row = await User.create(record);
  return asSeedResult(row, record);
}

/**
 * Inserts an SSO_PROVIDERS row, filling unique defaults for any omitted field.
 *
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {string} [overrides.providerKey] Stable machine slug (unique).
 * @param {string} [overrides.name] Human-facing provider label.
 * @param {number|boolean} [overrides.enabled] Whether the provider is enabled.
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded provider's id and values.
 */
export async function seedSsoProvider(overrides = {}) {
  const suffix = randomUUID().slice(0, 8);
  const record = {
    providerKey: `provider_${suffix}`,
    name: "Sample Provider",
    enabled: true,
    ...overrides,
  };

  const row = await SsoProvider.create(record);
  return asSeedResult(row, record);
}

/**
 * Inserts a USER_IDENTITIES row linking a user to an SSO provider, applying
 * defaults for any omitted field.
 *
 * @param {number} userId Id of the linked USERS row.
 * @param {number} providerId Id of the linked SSO_PROVIDERS row.
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {string} [overrides.providerUserId] Provider subject/sub (defaults to a fresh UUID).
 * @param {string|null} [overrides.email] Email reported by the provider.
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded identity's id and values.
 */
export async function seedUserIdentity(userId, providerId, overrides = {}) {
  const record = {
    userId,
    providerId,
    providerUserId: randomUUID(),
    email: null,
    ...overrides,
  };

  const row = await UserIdentity.create(record);
  return asSeedResult(row, record);
}

/**
 * Inserts a SUBSCRIPTIONS row recording that one user subscribed to another.
 *
 * @param {number} subscriberId Id of the subscribing USERS row.
 * @param {number} subscribedToId Id of the subscribed-to USERS row.
 * @returns {Promise<{id: number, subscriberId: number, subscribedToId: number}>} The seeded subscription's id and user ids.
 */
export async function seedSubscription(subscriberId, subscribedToId) {
  const row = await Subscription.create({ subscriberId, subscribedToId });
  return { id: row.id, subscriberId, subscribedToId };
}

/**
 * Inserts a NOTIFICATIONS row for a target user, applying defaults for any
 * omitted field.
 *
 * @param {number} userId Id of the target USERS row.
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {string|null} [overrides.notificationType] Free-form type string (nullable).
 * @param {string} [overrides.title] Notification title.
 * @param {string} [overrides.message] Notification message body.
 * @param {string|null} [overrides.readAt] Timestamp the notification was read (null when unread).
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded notification's id and values.
 */
export async function seedNotification(userId, overrides = {}) {
  const record = {
    userId,
    notificationType: null,
    title: "Sample notification",
    message: "Sample notification message",
    readAt: null,
    ...overrides,
  };

  const row = await Notification.create(record);
  return asSeedResult(row, record);
}

/**
 * Inserts a USER_NOTIFICATION_SETTINGS row for a user, applying defaults for any
 * omitted field.
 *
 * @param {number} userId Id of the USERS row the preference belongs to.
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {string|null} [overrides.notificationType] Free-form type string (nullable).
 * @param {number|boolean} [overrides.enabled] Whether the notification type is enabled.
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded setting's id and values.
 */
export async function seedUserNotificationSetting(userId, overrides = {}) {
  const record = {
    userId,
    notificationType: null,
    enabled: true,
    ...overrides,
  };

  const row = await UserNotificationSetting.create(record);
  return asSeedResult(row, record);
}

/**
 * Inserts a STATIC_PAGES row holding a block of HTML-formatted content,
 * applying defaults for any omitted field.
 *
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {string} [overrides.description] Short human-facing label for the block.
 * @param {string} [overrides.contents] HTML markup (must be under 10,000 characters).
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded page's id and values.
 */
export async function seedStaticPage(overrides = {}) {
  const record = {
    description: "Sample static page",
    contents: "<p>Sample static page content.</p>",
    ...overrides,
  };

  const row = await StaticPage.create(record);
  return asSeedResult(row, record);
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
