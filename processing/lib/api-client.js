/**
 * Base URL for the Justintube web API (no trailing slash).
 *
 * @type {string}
 */
const API_BASE_URL = (
  process.env.API_BASE_URL || "http://localhost:3000"
).replace(/\/$/, "");

/**
 * Shared bearer token for internal service-to-service calls.
 *
 * @type {string}
 */
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || "";

/**
 * Default timeout for outbound API callbacks, in milliseconds.
 *
 * @type {number}
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Posts a JSON body to an internal API path with the service bearer token.
 *
 * @param {string} path Absolute path beginning with `/` (e.g. `/internal/...`).
 * @param {object} body JSON-serializable request body.
 * @returns {Promise<{ ok: boolean, status: number, error: string|null }>}
 *   Outcome of the HTTP call.
 */
async function postInternal(path, body) {
  if (!INTERNAL_SERVICE_TOKEN) {
    return {
      ok: false,
      status: 0,
      error: "INTERNAL_SERVICE_TOKEN is not configured",
    };
  }

  const url = `${API_BASE_URL}${path}`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_SERVICE_TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : "network request failed",
    };
  }

  if (!response.ok) {
    let message = `API returned HTTP ${response.status}`;
    try {
      const parsed = await response.json();
      if (parsed && typeof parsed.message === "string") {
        message = parsed.message;
      } else if (parsed && typeof parsed.error === "string") {
        message = parsed.error;
      }
    } catch {
      // ignore body parse failures
    }
    return { ok: false, status: response.status, error: message };
  }

  return { ok: true, status: response.status, error: null };
}

/**
 * Notifies the API that a file version transcode completed successfully.
 *
 * @param {string} uuid File version UUID (BullMQ job id / FILE_VERSIONS.uuid_name).
 * @param {object} metadata Completion fields.
 * @param {number} metadata.fileSizeBytes Output size in bytes.
 * @param {number|null} metadata.videoWidth Output width.
 * @param {number|null} metadata.videoHeight Output height.
 * @param {string|null} metadata.resolution Resolution label.
 * @param {string} metadata.storagePath Relative storage path.
 * @param {string|null} metadata.mimeType MIME type.
 * @returns {Promise<{ ok: boolean, status: number, error: string|null }>}
 *   Callback outcome.
 */
export async function notifyFileVersionComplete(uuid, metadata) {
  return postInternal(`/internal/file-versions/${encodeURIComponent(uuid)}/complete`, {
    fileSizeBytes: metadata.fileSizeBytes,
    videoWidth: metadata.videoWidth,
    videoHeight: metadata.videoHeight,
    resolution: metadata.resolution,
    storagePath: metadata.storagePath,
    mimeType: metadata.mimeType,
  });
}

/**
 * Notifies the API that a file version transcode failed.
 *
 * @param {string} uuid File version UUID (BullMQ job id / FILE_VERSIONS.uuid_name).
 * @param {string} error Human-readable failure message.
 * @returns {Promise<{ ok: boolean, status: number, error: string|null }>}
 *   Callback outcome.
 */
export async function notifyFileVersionFailed(uuid, error) {
  return postInternal(`/internal/file-versions/${encodeURIComponent(uuid)}/fail`, {
    error,
  });
}

/**
 * Notifies the API that an upload's thumbnail was generated successfully.
 *
 * @param {string} uploadUuid ORIGINAL_UPLOADS.video_id (BullMQ job id for
 *   thumbnail jobs).
 * @param {object} metadata Completion fields.
 * @param {string} metadata.thumbnailFilename Basename written under `/media/thumbnails`.
 * @returns {Promise<{ ok: boolean, status: number, error: string|null }>}
 *   Callback outcome.
 */
export async function notifyThumbnailComplete(uploadUuid, metadata) {
  return postInternal(`/internal/thumbnails/${encodeURIComponent(uploadUuid)}/complete`, {
    thumbnailFilename: metadata.thumbnailFilename,
  });
}

/**
 * Notifies the API that an upload's auto-thumbnail-generation attempt failed
 * (neither embedded cover art nor a decoded-video-frame grab produced
 * anything) — the signal that lets the API fall back to the bundled
 * placeholder for an eligible audio upload.
 *
 * @param {string} uploadUuid ORIGINAL_UPLOADS.video_id (BullMQ job id for
 *   thumbnail jobs).
 * @param {string} error Human-readable failure message.
 * @returns {Promise<{ ok: boolean, status: number, error: string|null }>}
 *   Callback outcome.
 */
export async function notifyThumbnailFailed(uploadUuid, error) {
  return postInternal(`/internal/thumbnails/${encodeURIComponent(uploadUuid)}/failed`, {
    error,
  });
}

/**
 * Notifies the API that a duplicate-upload content-hash job completed
 * successfully.
 *
 * @param {string} jobId BullMQ job id (`hash-<videoId>`).
 * @param {object} metadata Completion fields.
 * @param {string} metadata.contentHash Computed `sha256:<hex>` content hash.
 * @returns {Promise<{ ok: boolean, status: number, error: string|null }>}
 *   Callback outcome.
 */
export async function notifyContentHashComplete(jobId, metadata) {
  return postInternal(`/internal/original-uploads/${encodeURIComponent(jobId)}/hash-complete`, {
    contentHash: metadata.contentHash,
  });
}

/**
 * Notifies the API that a duplicate-upload content-hash job failed.
 *
 * @param {string} jobId BullMQ job id (`hash-<videoId>`).
 * @param {string} error Human-readable failure message.
 * @returns {Promise<{ ok: boolean, status: number, error: string|null }>}
 *   Callback outcome.
 */
export async function notifyContentHashFailed(jobId, error) {
  return postInternal(`/internal/original-uploads/${encodeURIComponent(jobId)}/hash-failed`, {
    error,
  });
}

/**
 * Notifies the API that a FILETYPES_CONVERTIBLE upload's normalize job
 * (remux/transcode to H.264/AAC MP4) completed successfully.
 *
 * @param {string} jobId BullMQ job id (`normalize-<videoId>`).
 * @param {object} metadata Completion fields.
 * @param {number} metadata.fileSizeBytes Output size in bytes.
 * @param {number|null} metadata.videoWidth Output width (null for audio-only).
 * @param {number|null} metadata.videoHeight Output height (null for audio-only).
 * @param {string|null} metadata.resolution Resolution label (null for audio-only).
 * @param {string} metadata.storagePath Relative storage path (under `original/`).
 * @param {string} metadata.fileExtension New extension (`mp4` or `m4a`).
 * @param {string|null} metadata.mimeType MIME type.
 * @returns {Promise<{ ok: boolean, status: number, error: string|null }>}
 *   Callback outcome.
 */
export async function notifyOriginalUploadNormalizeComplete(jobId, metadata) {
  return postInternal(
    `/internal/original-uploads/${encodeURIComponent(jobId)}/normalize-complete`,
    {
      fileSizeBytes: metadata.fileSizeBytes,
      videoWidth: metadata.videoWidth,
      videoHeight: metadata.videoHeight,
      resolution: metadata.resolution,
      storagePath: metadata.storagePath,
      fileExtension: metadata.fileExtension,
      mimeType: metadata.mimeType,
    },
  );
}

/**
 * Notifies the API that a FILETYPES_CONVERTIBLE upload's normalize job failed.
 *
 * @param {string} jobId BullMQ job id (`normalize-<videoId>`).
 * @param {string} error Human-readable failure message.
 * @returns {Promise<{ ok: boolean, status: number, error: string|null }>}
 *   Callback outcome.
 */
export async function notifyOriginalUploadNormalizeFailed(jobId, error) {
  return postInternal(
    `/internal/original-uploads/${encodeURIComponent(jobId)}/normalize-failed`,
    { error },
  );
}

/**
 * Notifies the API that an audio upload's link-unfurl embed video (thumbnail
 * + audio muxed into an MP4) finished successfully.
 *
 * @param {string} jobId BullMQ job id (`embed-<videoId>-<uuid>` — unique per
 *   enqueue, since an upload's embed video can legitimately be regenerated
 *   more than once, unlike normalize/hash jobs).
 * @param {object} metadata Completion fields.
 * @param {string} metadata.storagePath Relative storage path (under `transcoded/`).
 * @param {number|null} metadata.videoWidth Output frame width.
 * @param {number|null} metadata.videoHeight Output frame height.
 * @param {boolean} metadata.isDefault Whether this was muxed from the fixed
 *   placeholder thumbnail rather than real cover art — lets the API refuse to
 *   let a slower placeholder-sourced completion overwrite a real one.
 * @returns {Promise<{ ok: boolean, status: number, error: string|null }>}
 *   Callback outcome.
 */
export async function notifyEmbedVideoComplete(jobId, metadata) {
  return postInternal(`/internal/original-uploads/${encodeURIComponent(jobId)}/embed-complete`, {
    storagePath: metadata.storagePath,
    videoWidth: metadata.videoWidth,
    videoHeight: metadata.videoHeight,
    isDefault: metadata.isDefault,
  });
}

/**
 * Notifies the API that an audio upload's link-unfurl embed video job failed.
 *
 * @param {string} jobId BullMQ job id (`embed-<videoId>-<uuid>` — unique per
 *   enqueue, since an upload's embed video can legitimately be regenerated
 *   more than once, unlike normalize/hash jobs).
 * @param {string} error Human-readable failure message.
 * @returns {Promise<{ ok: boolean, status: number, error: string|null }>}
 *   Callback outcome.
 */
export async function notifyEmbedVideoFailed(jobId, error) {
  return postInternal(`/internal/original-uploads/${encodeURIComponent(jobId)}/embed-failed`, {
    error,
  });
}
