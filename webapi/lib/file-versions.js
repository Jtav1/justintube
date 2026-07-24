import { FileVersion, OriginalUpload, TranscodeProfile } from "./models/index.js";

/**
 * Terminal FILE_VERSIONS status values (no further work expected).
 *
 * @type {Set<string>}
 */
const TERMINAL_STATUSES = new Set(["complete", "failed"]);

/**
 * Applies completion metadata to a file version row (idempotent if already complete).
 *
 * @param {import('sequelize').Model} version FileVersion instance.
 * @param {object} metadata Completion fields from processing.
 * @param {number} [metadata.fileSizeBytes] Output size in bytes.
 * @param {number|null} [metadata.videoWidth] Output width.
 * @param {number|null} [metadata.videoHeight] Output height.
 * @param {string|null} [metadata.resolution] Resolution label.
 * @param {string} [metadata.storagePath] Relative storage path.
 * @param {string|null} [metadata.mimeType] MIME type.
 * @returns {Promise<import('sequelize').Model>} Updated (or unchanged) instance.
 */
export async function applyFileVersionComplete(version, metadata = {}) {
  if (version.status === "complete") {
    return version;
  }

  const updates = { status: "complete" };
  if (metadata.fileSizeBytes != null) {
    updates.fileSizeBytes = metadata.fileSizeBytes;
  }
  if (metadata.videoWidth !== undefined) {
    updates.videoWidth = metadata.videoWidth;
  }
  if (metadata.videoHeight !== undefined) {
    updates.videoHeight = metadata.videoHeight;
  }
  if (metadata.resolution !== undefined) {
    updates.resolution = metadata.resolution;
  }
  if (typeof metadata.storagePath === "string" && metadata.storagePath) {
    updates.storagePath = metadata.storagePath;
  }
  if (metadata.mimeType !== undefined) {
    updates.mimeType = metadata.mimeType;
  }

  await version.update(updates);
  await rollupOriginalUploadStatus(version.originalUploadId);
  return version;
}

/**
 * Marks a file version as failed (no-op if already complete).
 *
 * @param {import('sequelize').Model} version FileVersion instance.
 * @returns {Promise<import('sequelize').Model>} Updated (or unchanged) instance.
 */
export async function applyFileVersionFailed(version) {
  if (version.status === "complete") {
    return version;
  }
  if (version.status !== "failed") {
    await version.update({ status: "failed" });
  }
  await rollupOriginalUploadStatus(version.originalUploadId);
  return version;
}

/**
 * Marks every non-terminal file version for an upload as failed.
 *
 * @param {number} originalUploadId Parent ORIGINAL_UPLOADS id.
 * @returns {Promise<void>} Resolves when updates complete.
 */
export async function markUploadFileVersionsFailed(originalUploadId) {
  const versions = await FileVersion.findAll({
    where: { originalUploadId },
  });
  for (const version of versions) {
    if (!TERMINAL_STATUSES.has(version.status)) {
      await version.update({ status: "failed" });
    }
  }
  await rollupOriginalUploadStatus(originalUploadId);
}

/**
 * Sets ORIGINAL_UPLOADS.status from the aggregate of its FILE_VERSIONS rows.
 *
 * - any pending/processing → `processing`
 * - all complete → `ready`
 * - mix of complete/failed with no in-flight → `partial`
 * - all failed → `failed`
 * - no versions → leave unchanged
 *
 * @param {number} originalUploadId Parent upload id.
 * @returns {Promise<void>} Resolves after the upload row is updated (when needed).
 */
export async function rollupOriginalUploadStatus(originalUploadId) {
  const upload = await OriginalUpload.findByPk(originalUploadId);
  if (!upload) {
    return;
  }

  const versions = await FileVersion.findAll({
    where: { originalUploadId },
  });
  if (versions.length === 0) {
    return;
  }

  const statuses = versions.map((v) => v.status);
  const hasInFlight = statuses.some(
    (s) => s === "pending" || s === "processing",
  );
  const allComplete = statuses.every((s) => s === "complete");
  const allFailed = statuses.every((s) => s === "failed");

  let nextStatus = upload.status;
  if (hasInFlight) {
    nextStatus = "processing";
  } else if (allComplete) {
    nextStatus = "ready";
  } else if (allFailed) {
    nextStatus = "failed";
  } else {
    nextStatus = "partial";
  }

  if (upload.status !== nextStatus) {
    await upload.update({ status: nextStatus });
  }
}

/**
 * Loads a file version by uuid_name.
 *
 * @param {string} uuid File version UUID.
 * @returns {Promise<import('sequelize').Model|null>} Matching row, or null.
 */
export async function findFileVersionByUuid(uuid) {
  return FileVersion.findOne({ where: { uuidName: uuid } });
}

/**
 * Loads the transcode profile payload fields needed to re-enqueue a job.
 *
 * @param {number} profileId TRANSCODE_PROFILES id.
 * @returns {Promise<object|null>} Profile payload, or null when missing.
 */
export async function loadTranscodeProfilePayload(profileId) {
  const row = await TranscodeProfile.findByPk(profileId);
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    outputHeight: row.outputHeight,
    outputWidth: row.outputWidth,
    outputContainer: row.outputContainer,
    videoCodec: row.videoCodec,
    audioCodec: row.audioCodec,
  };
}
