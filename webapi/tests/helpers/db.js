import { randomUUID } from "node:crypto";
import { hashApiKey, apiKeyPrefix } from "../../lib/auth/api-key.js";
import { hashVerificationToken } from "../../lib/auth/email-verification.js";
import { query } from "../../lib/db.js";
import { generateVideoId } from "../../lib/video-id.js";
import {
  AccessPermission,
  Comment,
  ContentTag,
  FeaturedVideo,
  EmailVerificationToken,
  FileVersion,
  Notification,
  NotificationType,
  OriginalUpload,
  PlaylistAccess,
  PlaylistItem,
  Report,
  Role,
  SsoProvider,
  StaticPage,
  Subscription,
  SystemConfig,
  Theme,
  TranscodeProfile,
  User,
  UserApiKey,
  UserHiddenVideo,
  UserIdentity,
  UserNotificationSetting,
  UserPlaylist,
  UserViewHistory,
  VideoAccess,
  VideoLike,
  VideoMetadata,
  VideoThumbnail,
  VideoTransferHistory,
  VideoTransferMapping,
} from "../../lib/models/index.js";
import { PUBLIC_THEME_OWNER } from "../../lib/models/theme.js";
import { ensureSchema } from "../../lib/schema.js";
import { ensureUserNotificationSettings } from "../../lib/seed.js";

/**
 * Models that hold per-test data, ordered so that children are deleted before
 * their parents (satisfying foreign-key constraints during a reset). Role and
 * NotificationType are intentionally omitted so the reference data seeded by
 * `ensureSchema` survives across resets and remains available for `seedUser`
 * and `seedNotification`/`seedUserNotificationSetting`.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>[]}
 */
const RESET_MODELS = [
  PlaylistItem,
  PlaylistAccess,
  FileVersion,
  VideoMetadata,
  VideoThumbnail,
  VideoLike,
  UserViewHistory,
  VideoAccess,
  UserHiddenVideo,
  ContentTag,
  Comment,
  FeaturedVideo,
  UserPlaylist,
  OriginalUpload,
  TranscodeProfile,
  VideoTransferHistory,
  VideoTransferMapping,
  Subscription,
  Notification,
  UserNotificationSetting,
  UserIdentity,
  UserApiKey,
  EmailVerificationToken,
  Report,
  User,
  SsoProvider,
  StaticPage,
  SystemConfig,
  Theme,
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
 * @param {string} [overrides.videoId] Public video id (defaults to a fresh generated id).
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
    videoId: generateVideoId(),
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
 * Inserts a PLAYLIST_ACCESS row granting a user permission to view (or edit)
 * a private playlist.
 *
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {number} overrides.playlistId Owning playlist id.
 * @param {number} overrides.userId Granted user id.
 * @param {string} [overrides.permission] "view" or "edit" (defaults to "view").
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded grant's id and values.
 */
export async function seedPlaylistAccess(overrides = {}) {
  const { permission = "view", ...rest } = overrides;
  const permissionRow = await AccessPermission.findOne({ where: { name: permission } });
  const record = {
    playlistId: null,
    userId: null,
    permissionId: permissionRow.id,
    ...rest,
  };

  const row = await PlaylistAccess.create(record);
  return asSeedResult(row, { ...record, permission });
}

/**
 * Inserts a PLAYLIST_ITEMS row linking a video into a playlist.
 *
 * @param {number} playlistId Owning USER_PLAYLISTS id.
 * @param {number} originalUploadId Id of the linked ORIGINAL_UPLOADS row.
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {number|null} [overrides.position] Manual sort position.
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded item's id and values.
 */
export async function seedPlaylistItem(playlistId, originalUploadId, overrides = {}) {
  const record = {
    playlistId,
    originalUploadId,
    position: null,
    ...overrides,
  };

  const row = await PlaylistItem.create(record);
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
    transcodeProfileId: null,
    ...overrides,
  };

  const row = await FileVersion.create(record);
  return asSeedResult(row, record);
}

/**
 * Inserts a VIDEO_THUMBNAIL row for an existing upload, applying defaults for
 * any omitted field.
 *
 * @param {number} originalUploadId Id of the parent ORIGINAL_UPLOADS row.
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {string} [overrides.thumbnailFilename] On-disk thumbnail filename.
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded thumbnail's id and values.
 */
export async function seedVideoThumbnail(originalUploadId, overrides = {}) {
  const record = {
    originalUploadId,
    thumbnailFilename: `${randomUUID()}.jpg`,
    ...overrides,
  };

  const row = await VideoThumbnail.create(record);
  return asSeedResult(row, record);
}

/**
 * Inserts a TRANSCODE_PROFILES row, applying defaults for any omitted field.
 *
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {string|null} [overrides.description] Optional human-readable profile note.
 * @param {string} [overrides.resolutionName] Resolution label from RESOLUTION_VALUES.
 * @param {number} [overrides.outputHeight] Output frame height in pixels.
 * @param {number} [overrides.outputWidth] Output frame width in pixels.
 * @param {string} [overrides.outputContainer] Container format (e.g. mp4).
 * @param {string} [overrides.videoCodec] Video codec name (e.g. h264).
 * @param {string} [overrides.audioCodec] Audio codec name (e.g. aac).
 * @param {number|null} [overrides.creatorUserId] Creating user's id (nullable).
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded profile's id and values.
 */
export async function seedTranscodeProfile(overrides = {}) {
  const record = {
    description: null,
    resolutionName: "720p",
    outputHeight: 720,
    outputWidth: 1280,
    outputContainer: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    creatorUserId: null,
    ...overrides,
  };

  const row = await TranscodeProfile.create(record);
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
 * Inserts (or, on a repeat originalUploadId/userId pair, updates) a
 * USER_VIEW_HISTORY row for an existing upload, applying defaults for any
 * omitted field. There is a unique constraint on (userId, originalUploadId) -
 * pass distinct `updatedAt` overrides to control ordering across rows instead
 * of seeding the same pair twice.
 *
 * @param {number} originalUploadId Id of the parent ORIGINAL_UPLOADS row.
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {number|null} [overrides.userId] Viewing user id.
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded history row's id and values.
 */
export async function seedUserViewHistory(originalUploadId, overrides = {}) {
  const record = {
    originalUploadId,
    userId: null,
    ...overrides,
  };

  const existing = await UserViewHistory.findOne({
    where: { originalUploadId: record.originalUploadId, userId: record.userId },
  });
  const row = existing
    ? await existing.update(record)
    : await UserViewHistory.create(record);
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
 * Inserts a COMMENTS row on an existing upload, applying defaults for any
 * omitted field.
 *
 * @param {number} originalUploadId Id of the parent ORIGINAL_UPLOADS row.
 * @param {number|null} userId Id of the commenting USERS row (nullable).
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {string} [overrides.body] Comment text.
 * @param {number|null} [overrides.parentCommentId] Parent comment id, for replies.
 * @param {boolean} [overrides.distinguishedMod] Moderator-distinguished flag.
 * @param {boolean} [overrides.distinguishedAdmin] Admin-distinguished flag.
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded comment's id and values.
 */
export async function seedComment(originalUploadId, userId, overrides = {}) {
  const record = {
    originalUploadId,
    userId,
    parentCommentId: null,
    body: "sample comment",
    distinguishedMod: false,
    distinguishedAdmin: false,
    ...overrides,
  };

  const row = await Comment.create(record);
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
 * Inserts a VIDEO_ACCESS row granting a user permission to view (or edit) a
 * private upload.
 *
 * @param {number} originalUploadId Id of the parent ORIGINAL_UPLOADS row.
 * @param {number} userId Id of the USERS row receiving access.
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {string} [overrides.permission] "view" or "edit" (defaults to "view").
 * @returns {Promise<{id: number, originalUploadId: number, userId: number, permission: string}>}
 *   The seeded grant's id, foreign keys, and permission name.
 */
export async function seedVideoAccess(originalUploadId, userId, overrides = {}) {
  const { permission = "view" } = overrides;
  const permissionRow = await AccessPermission.findOne({ where: { name: permission } });
  const row = await VideoAccess.create({
    originalUploadId,
    userId,
    permissionId: permissionRow.id,
  });
  return { id: row.id, originalUploadId, userId, permission };
}

/**
 * Inserts a USER_HIDDEN_VIDEOS row recording that a user has hidden an
 * upload from their own listings.
 *
 * @param {number} originalUploadId Id of the parent ORIGINAL_UPLOADS row.
 * @param {number} userId Id of the USERS row hiding the video.
 * @returns {Promise<{id: number, originalUploadId: number, userId: number}>}
 *   The seeded row's id and foreign keys.
 */
export async function seedUserHiddenVideo(originalUploadId, userId) {
  const row = await UserHiddenVideo.create({ originalUploadId, userId });
  return { id: row.id, originalUploadId, userId };
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
 * @param {number|boolean} [overrides.passwordExpired] Whether the password must be changed.
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
    passwordExpired: false,
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
  // Mirrors registration (routes/auth.js): every user gets an explicit
  // USER_NOTIFICATION_SETTINGS row per active type, seeded with that type's
  // default. Requires NOTIFICATION_TYPES to already be seeded, which
  // setupSchema()'s ensureSchema() call guarantees before any test body runs.
  await ensureUserNotificationSettings(row.id);
  return asSeedResult(row, record);
}

/**
 * Inserts a USER_API_KEYS row for an existing user. Hashes `rawKey` with
 * SHA-256; defaults to a far-future expiry and a null `revokedAt`.
 *
 * @param {number} userId Owning USERS id.
 * @param {string} rawKey Plaintext API key used by tests in Authorization headers.
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {string} [overrides.name] Human-facing key label.
 * @param {string|null} [overrides.description] Optional description.
 * @param {Date|string} [overrides.expiresAt] Expiry timestamp.
 * @param {Date|string|null} [overrides.revokedAt] Revocation timestamp (null = active).
 * @returns {Promise<{id: number, rawKey: string} & Record<string, unknown>>} Seeded key metadata plus rawKey.
 */
export async function seedUserApiKey(userId, rawKey, overrides = {}) {
  const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const record = {
    userId,
    name: "test-key",
    description: null,
    keyHash: hashApiKey(rawKey),
    keyPrefix: apiKeyPrefix(rawKey),
    expiresAt: farFuture,
    revokedAt: null,
    ...overrides,
  };

  const row = await UserApiKey.create(record);
  return { ...asSeedResult(row, record), rawKey };
}

/**
 * Inserts an EMAIL_VERIFICATION_TOKENS row for an existing user. Hashes `rawToken`
 * with SHA-256; defaults to a 24-hour expiry.
 *
 * @param {number} userId Owning USERS id.
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {string} [overrides.rawToken] Plaintext token (defaults to a random value).
 * @param {Date|string} [overrides.expiresAt] Expiry timestamp.
 * @returns {Promise<{id: number, rawToken: string} & Record<string, unknown>>} Seeded token metadata plus rawToken.
 */
export async function seedEmailVerificationToken(userId, overrides = {}) {
  const rawToken =
    overrides.rawToken || randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const { rawToken: _ignored, ...rest } = overrides;
  const record = {
    userId,
    tokenHash: hashVerificationToken(rawToken),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    ...rest,
  };

  const row = await EmailVerificationToken.create(record);
  return { ...asSeedResult(row, record), rawToken };
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
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {Date|string} [overrides.createdAt] Timestamp the subscription was created.
 * @returns {Promise<{id: number, subscriberId: number, subscribedToId: number}>} The seeded subscription's id and user ids.
 */
export async function seedSubscription(subscriberId, subscribedToId, overrides = {}) {
  const row = await Subscription.create({ subscriberId, subscribedToId, ...overrides });
  return { id: row.id, subscriberId, subscribedToId };
}

/**
 * Inserts a NOTIFICATIONS row for a target user, applying defaults for any
 * omitted field. `notificationTypeId` is required by the model, so when no
 * override is passed this looks up the first active NOTIFICATION_TYPES row.
 *
 * @param {number} userId Id of the target USERS row.
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {number} [overrides.notificationTypeId] Id of a NOTIFICATION_TYPES row.
 * @param {string} [overrides.title] Notification title.
 * @param {string} [overrides.message] Notification message body.
 * @param {string|null} [overrides.readAt] Timestamp the notification was read (null when unread).
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded notification's id and values.
 */
export async function seedNotification(userId, overrides = {}) {
  const notificationTypeId =
    overrides.notificationTypeId ??
    (
      await NotificationType.findOne({
        where: { enabled: true },
        order: [["id", "ASC"]],
      })
    )?.id;

  const record = {
    userId,
    notificationTypeId,
    title: "Sample notification",
    message: "Sample notification message",
    readAt: null,
    ...overrides,
  };

  const row = await Notification.create(record);
  return asSeedResult(row, record);
}

/**
 * Upserts a USER_NOTIFICATION_SETTINGS row for a user, applying defaults for
 * any omitted field. Upserts (rather than plain `create`) because `seedUser`
 * already auto-creates a row per active notification type - this overrides
 * that auto-seeded row for the given `notificationTypeId` rather than
 * violating its unique `(user_id, notification_type_id)` index.
 *
 * @param {number} userId Id of the USERS row the preference belongs to.
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {number|null} [overrides.notificationTypeId] Id of a NOTIFICATION_TYPES row (nullable).
 * @param {number|boolean} [overrides.enabled] Whether the notification type is enabled.
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded setting's id and values.
 */
export async function seedUserNotificationSetting(userId, overrides = {}) {
  const record = {
    userId,
    notificationTypeId: null,
    enabled: true,
    emailEnabled: true,
    ...overrides,
  };

  const [row] = await UserNotificationSetting.findOrCreate({
    where: { userId: record.userId, notificationTypeId: record.notificationTypeId },
    defaults: record,
  });
  await row.update(record);
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
 * Inserts a SYSTEM_CONFIG name/value row, applying defaults for any omitted field.
 *
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {string} [overrides.name] Unique configuration variable name.
 * @param {string} [overrides.value] Configuration value string.
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded config's id and values.
 */
export async function seedSystemConfig(overrides = {}) {
  const suffix = randomUUID().slice(0, 8);
  const record = {
    name: `config_${suffix}`,
    value: "sample-value",
    ...overrides,
  };

  const row = await SystemConfig.create(record);
  return asSeedResult(row, record);
}

/**
 * Inserts a THEMES row, applying defaults for any omitted field. Defaults to
 * a `"public"`-owned, non-default theme with no background images.
 *
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {string} [overrides.name] Theme name.
 * @param {string|null} [overrides.description] Optional description.
 * @param {string} [overrides.color1] 6-character hex color (no leading `#`).
 * @param {string} [overrides.color2] 6-character hex color (no leading `#`).
 * @param {string} [overrides.color3] 6-character hex color (no leading `#`).
 * @param {string} [overrides.color4] 6-character hex color (no leading `#`).
 * @param {string} [overrides.color5] 6-character hex color (no leading `#`).
 * @param {string|null} [overrides.headerBackgroundFilename] Header background filename.
 * @param {string|null} [overrides.sidebarBackgroundFilename] Sidebar background filename.
 * @param {string|null} [overrides.viewBackgroundFilename] View background filename.
 * @param {string|null} [overrides.footerBackgroundFilename] Footer background filename.
 * @param {string} [overrides.themeOwner] `String(userId)` or `PUBLIC_THEME_OWNER`.
 * @param {number|boolean} [overrides.isDefault] Whether this is the sitewide fallback theme.
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded theme's id and values.
 */
export async function seedTheme(overrides = {}) {
  const record = {
    name: "Sample Theme",
    description: null,
    color1: "FFFFFF",
    color2: "000000",
    color3: "FF0000",
    color4: "00FF00",
    color5: "0000FF",
    headerBackgroundFilename: null,
    sidebarBackgroundFilename: null,
    viewBackgroundFilename: null,
    footerBackgroundFilename: null,
    themeOwner: PUBLIC_THEME_OWNER,
    isDefault: false,
    ...overrides,
  };

  const row = await Theme.create(record);
  return asSeedResult(row, record);
}

/**
 * Inserts a REPORTS row, applying defaults for any omitted field.
 *
 * @param {number} reporterUserId Id of the reporting USERS row.
 * @param {object} [overrides] Partial column values to override the defaults.
 * @param {string} [overrides.reportType] One of REPORT_TYPE_VALUES.
 * @param {string} [overrides.link] Client-supplied page URL.
 * @param {string} [overrides.description] Report description.
 * @param {number|null} [overrides.videoId] Reported ORIGINAL_UPLOADS id.
 * @param {number|null} [overrides.reportedUserId] Reported USERS id.
 * @param {number|null} [overrides.playlistId] Reported USER_PLAYLISTS id.
 * @param {boolean} [overrides.resolved] Resolution state.
 * @param {string|null} [overrides.comment] Moderator comment text.
 * @param {number|null} [overrides.commenterUserId] Commenting moderator/admin id.
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded report's id and values.
 */
export async function seedReport(reporterUserId, overrides = {}) {
  const record = {
    reporterUserId,
    reportType: "video",
    link: "https://example.com/videos/sample",
    description: "sample report",
    videoId: null,
    reportedUserId: null,
    playlistId: null,
    resolved: false,
    comment: null,
    commenterUserId: null,
    ...overrides,
  };

  const row = await Report.create(record);
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
