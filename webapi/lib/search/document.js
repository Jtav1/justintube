import {
  ContentTag,
  OriginalUpload,
  PlaylistItem,
  Role,
  User,
  UserPlaylist,
  VideoMetadata,
  VideoThumbnail,
} from "../models/index.js";

/**
 * Loads the searchable document for an upload, or null when it isn't eligible
 * to appear in search (missing metadata, or not public). Eligibility is
 * intentionally independent of transcode status — not every deployment
 * configures transcode profiles, so a video can be fully public and playable
 * via its original file without ever reaching `status: "ready"`. This is the
 * single source of truth for search eligibility, shared by every search
 * backend so they can never diverge in shape or rules.
 *
 * @param {number} originalUploadId ORIGINAL_UPLOADS id.
 * @returns {Promise<object|null>} Document payload, or null when not eligible.
 */
export async function loadEligibleDocument(originalUploadId) {
  const upload = await OriginalUpload.findByPk(originalUploadId, {
    include: [
      { model: VideoMetadata, as: "VideoMetadata", required: false },
      { model: User, required: false },
      { model: VideoThumbnail, required: false },
    ],
  });
  if (!upload || !upload.VideoMetadata) {
    return null;
  }
  if (upload.VideoMetadata.visibility !== "public") {
    return null;
  }

  const tags = await ContentTag.findAll({ where: { originalUploadId } });

  return {
    id: upload.id,
    videoId: upload.videoId,
    title: upload.VideoMetadata.title,
    description: upload.VideoMetadata.description ?? "",
    tags: tags.map((t) => t.tag),
    userId: upload.userId ?? null,
    username: upload.User?.username ?? null,
    displayName: upload.User?.displayName ?? null,
    visibility: upload.VideoMetadata.visibility,
    commentsEnabled: Boolean(upload.VideoMetadata.commentsEnabled),
    viewCount: Number(upload.VideoMetadata.viewCount ?? 0),
    durationSeconds: upload.durationSeconds ?? null,
    thumbnailUrl: upload.VideoThumbnail
      ? `/api/v1/videos/${upload.id}/thumbnail`
      : null,
    createdAt: upload.VideoMetadata.createdAt,
    updatedAt: upload.VideoMetadata.updatedAt,
  };
}

/**
 * Bulk-loads every eligible (public) video's search document. Used to build a
 * search backend's index from scratch (e.g. the in-process basic backend's
 * lazy initial build).
 *
 * @returns {Promise<object[]>} Eligible documents, in `loadEligibleDocument` shape.
 */
export async function loadAllEligibleDocuments() {
  const uploads = await OriginalUpload.findAll({
    include: [
      {
        model: VideoMetadata,
        as: "VideoMetadata",
        required: true,
        where: { visibility: "public" },
      },
      { model: User, required: false },
    ],
    attributes: ["id"],
  });

  const docs = [];
  for (const upload of uploads) {
    const doc = await loadEligibleDocument(upload.id);
    if (doc) {
      docs.push(doc);
    }
  }
  return docs;
}

/**
 * Loads the searchable document for a playlist, or null when it isn't
 * eligible to appear in search (missing, or not public). Member videos are
 * filtered to public ones only, since the index has no per-viewer concept and
 * a playlist's search content shouldn't leak private/unlisted video titles.
 *
 * @param {number} playlistId USER_PLAYLISTS id.
 * @returns {Promise<object|null>} Document payload, or null when not eligible.
 */
export async function loadEligiblePlaylistDocument(playlistId) {
  const playlist = await UserPlaylist.findByPk(playlistId, {
    include: [{ model: User, required: false }],
  });
  if (!playlist || playlist.visibility !== "public") {
    return null;
  }

  const items = await PlaylistItem.findAll({
    where: { playlistId },
    include: [
      {
        model: OriginalUpload,
        required: true,
        include: [{ model: VideoMetadata, as: "VideoMetadata", required: true }],
      },
    ],
  });
  const publicItems = items.filter(
    (item) => item.OriginalUpload.VideoMetadata.visibility === "public",
  );

  const tagRows = publicItems.length > 0
    ? await ContentTag.findAll({
      where: { originalUploadId: publicItems.map((item) => item.OriginalUpload.id) },
    })
    : [];

  return {
    id: playlist.id,
    title: playlist.title,
    description: playlist.description ?? "",
    userId: playlist.userId ?? null,
    username: playlist.User?.username ?? null,
    displayName: playlist.User?.displayName ?? null,
    visibility: playlist.visibility,
    itemCount: items.length,
    contentTitles: publicItems.map((item) => item.OriginalUpload.VideoMetadata.title),
    contentTags: [...new Set(tagRows.map((t) => t.tag))],
    createdAt: playlist.createdAt,
    updatedAt: playlist.updatedAt,
  };
}

/**
 * Bulk-loads every eligible (public) playlist's search document. Used to
 * build a search backend's playlist index from scratch.
 *
 * @returns {Promise<object[]>} Eligible documents, in `loadEligiblePlaylistDocument` shape.
 */
export async function loadAllEligiblePlaylistDocuments() {
  const playlists = await UserPlaylist.findAll({
    where: { visibility: "public" },
    attributes: ["id"],
  });

  const docs = [];
  for (const playlist of playlists) {
    const doc = await loadEligiblePlaylistDocument(playlist.id);
    if (doc) {
      docs.push(doc);
    }
  }
  return docs;
}

/**
 * Loads the searchable document for a user, or null when it isn't eligible
 * to appear in search (missing, or locked). Deliberately lean — only the
 * fields needed to *match* a query; rendering fields (bio, avatar, upload
 * count) are hydrated from the database after search, not stored in the
 * index, so they never go stale between edits and a rebuild.
 *
 * @param {number} userId USERS id.
 * @returns {Promise<object|null>} Document payload, or null when not eligible.
 */
export async function loadEligibleUserDocument(userId) {
  const user = await User.findByPk(userId, {
    include: [{ model: Role, required: false }],
  });
  if (!user || user.Role?.name === "locked") {
    return null;
  }

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName ?? null,
  };
}

/**
 * Bulk-loads every eligible (non-locked) user's search document. Used to
 * build a search backend's user index from scratch.
 *
 * @returns {Promise<object[]>} Eligible documents, in `loadEligibleUserDocument` shape.
 */
export async function loadAllEligibleUserDocuments() {
  const users = await User.findAll({
    include: [{ model: Role, required: false }],
    attributes: ["id"],
  });

  const docs = [];
  for (const user of users) {
    const doc = await loadEligibleUserDocument(user.id);
    if (doc) {
      docs.push(doc);
    }
  }
  return docs;
}
