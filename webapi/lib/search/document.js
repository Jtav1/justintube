import { ContentTag, OriginalUpload, User, VideoMetadata } from "../models/index.js";

/**
 * Loads the searchable document for an upload, or null when it isn't eligible
 * to appear in search (missing metadata, not yet processed, or not public).
 * This is the single source of truth for search eligibility, shared by every
 * search backend so they can never diverge in shape or rules.
 *
 * @param {number} originalUploadId ORIGINAL_UPLOADS id.
 * @returns {Promise<object|null>} Document payload, or null when not eligible.
 */
export async function loadEligibleDocument(originalUploadId) {
  const upload = await OriginalUpload.findByPk(originalUploadId, {
    include: [
      { model: VideoMetadata, as: "VideoMetadata", required: false },
      { model: User, required: false },
    ],
  });
  if (!upload || !upload.VideoMetadata) {
    return null;
  }
  if (upload.status !== "ready") {
    return null;
  }
  if (upload.VideoMetadata.visibility !== "public") {
    return null;
  }

  const tags = await ContentTag.findAll({ where: { originalUploadId } });

  return {
    id: upload.id,
    title: upload.VideoMetadata.title,
    description: upload.VideoMetadata.description ?? "",
    tags: tags.map((t) => t.tag),
    userId: upload.userId ?? null,
    username: upload.User?.username ?? null,
    displayName: upload.User?.displayName ?? null,
    visibility: upload.VideoMetadata.visibility,
    commentsEnabled: Boolean(upload.VideoMetadata.commentsEnabled),
    viewCount: Number(upload.VideoMetadata.viewCount ?? 0),
    createdAt: upload.VideoMetadata.createdAt,
    updatedAt: upload.VideoMetadata.updatedAt,
  };
}

/**
 * Bulk-loads every eligible (ready + public) video's search document. Used to
 * build a search backend's index from scratch (e.g. the in-process basic
 * backend's lazy initial build).
 *
 * @returns {Promise<object[]>} Eligible documents, in `loadEligibleDocument` shape.
 */
export async function loadAllEligibleDocuments() {
  const uploads = await OriginalUpload.findAll({
    where: { status: "ready" },
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
