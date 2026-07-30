/**
 * Base URL for the processing service (no trailing slash). Defaults to local
 * processing when unset.
 *
 * @type {string}
 */
const PROCESSING_API_URL = (
  process.env.PROCESSING_API_URL || "http://localhost:3001"
).replace(/\/$/, "");

/**
 * Default timeout for outbound processing requests, in milliseconds.
 *
 * @type {number}
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Profile fields accepted by `POST /transcode` on the processing service.
 *
 * @typedef {object} TranscodeProfilePayload
 * @property {number} id Transcode profile id.
 * @property {number} outputHeight Target frame height in pixels.
 * @property {number} outputWidth Target frame width in pixels.
 * @property {string} outputContainer Output container / extension (e.g. mp4).
 * @property {string} videoCodec Requested video codec name.
 * @property {string} audioCodec Requested audio codec name.
 */

/**
 * One job descriptor in a batch `POST /transcode` request. Two kinds:
 * - `kind: "rendition"` — a normal profile-based transcode. `profile` is
 *   required; `timestampSeconds` is unused. `jobId` is FILE_VERSIONS.uuid_name,
 *   output lands under `/media/transcoded`.
 * - `kind: "thumbnail"` — a single-frame extraction, always included
 *   regardless of transcode profile count. `timestampSeconds` is the
 *   requested frame timestamp (`null` = let processing pick a random one, or
 *   whenever the requested value exceeds the video's actual duration);
 *   `profile` is unused. `jobId` is ORIGINAL_UPLOADS.video_id, output lands
 *   under `/media/thumbnails`.
 *
 * @typedef {object} TranscodeBatchJob
 * @property {string} jobId Stable BullMQ job id.
 * @property {string} outputFilename Basename under the job kind's output directory.
 * @property {"rendition"|"thumbnail"} kind Job kind, dispatched on by processing.
 * @property {TranscodeProfilePayload} [profile] Required for `kind: "rendition"`.
 * @property {number|null} [timestampSeconds] Required for `kind: "thumbnail"`.
 */

/**
 * Result of a batch `POST /transcode` call to the processing service.
 *
 * @typedef {object} TranscodeBatchRequestResult
 * @property {boolean} ok Whether the response status was in the 2xx range.
 * @property {number} status HTTP status code (0 when the request failed before a response).
 * @property {object|null} body Parsed JSON body, or null when parsing failed / no body.
 * @property {string|null} error Human-readable error message when `ok` is false.
 */

/**
 * Result of a `GET /transcode/:jobId` call.
 *
 * @typedef {object} TranscodeJobStatusResult
 * @property {boolean} ok Whether the job was found (HTTP 200).
 * @property {number} status HTTP status code (0 on network failure).
 * @property {object|null} body Parsed JSON body when present.
 * @property {string|null} error Error message when `ok` is false.
 */

/**
 * Result of a `POST /download` call to the processing service.
 *
 * @typedef {object} DownloadRequestResult
 * @property {boolean} ok Whether the response status was in the 2xx range.
 * @property {number} status HTTP status code (0 when the request failed before a response).
 * @property {object|null} body Parsed JSON body (`{ success, filename }` on success).
 * @property {string|null} error Human-readable error message when `ok` is false.
 */

/**
 * Posts JSON to the processing service and returns a normalized outcome.
 *
 * @param {string} path Absolute path beginning with `/`.
 * @param {object} [options] Request options.
 * @param {string} [options.method] HTTP method (default POST).
 * @param {object|null} [options.body] JSON body (null for no body).
 * @returns {Promise<{ ok: boolean, status: number, body: object|null, error: string|null }>}
 *   Normalized HTTP outcome.
 */
async function processingFetch(path, options = {}) {
  const method = options.method || "POST";
  const url = `${PROCESSING_API_URL}${path}`;

  let response;
  try {
    /** @type {RequestInit} */
    const init = {
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN || ""}`,
      },
    };
    if (options.body != null) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    response = await fetch(url, init);
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: err instanceof Error ? err.message : "network request failed",
    };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const errorFromBody =
      body && typeof body === "object" && typeof body.error === "string"
        ? body.error
        : `processing returned HTTP ${response.status}`;
    return {
      ok: false,
      status: response.status,
      body,
      error: errorFromBody,
    };
  }

  return {
    ok: true,
    status: response.status,
    body,
    error: null,
  };
}

/**
 * Queues one or more transcode jobs on the processing service in a single request.
 *
 * @param {object} options Request payload.
 * @param {string} options.filename Basename of the file under media/original.
 * @param {TranscodeBatchJob[]} options.jobs Job descriptors (jobId, output, profile).
 * @returns {Promise<TranscodeBatchRequestResult>} Outcome of the processing call.
 */
export async function requestTranscodeBatch({ filename, jobs }) {
  return processingFetch("/transcode", {
    method: "POST",
    body: { filename, jobs },
  });
}

/**
 * Asks the processing service to download a remote video via yt-dlp into the
 * shared `original/` media directory.
 *
 * @param {string} url Absolute http(s) URL to download.
 * @returns {Promise<DownloadRequestResult>} Outcome of the processing call.
 */
export async function requestDownload(url) {
  return processingFetch("/download", {
    method: "POST",
    body: { url },
  });
}

/**
 * Loads BullMQ job status from the processing service.
 *
 * @param {string} jobId Transcode job id (file version UUID).
 * @returns {Promise<TranscodeJobStatusResult>} Status lookup outcome.
 */
export async function getTranscodeJobStatus(jobId) {
  return processingFetch(`/transcode/${encodeURIComponent(jobId)}`, {
    method: "GET",
    body: null,
  });
}

/**
 * Removes a transcode job from the processing Redis queue.
 *
 * @param {string} jobId Transcode job id to remove.
 * @returns {Promise<TranscodeBatchRequestResult>} Delete outcome.
 */
export async function removeTranscodeJob(jobId) {
  return processingFetch(`/transcode/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
    body: null,
  });
}

/**
 * Checks whether the processing service is reachable and reports itself
 * healthy. Used to gate features that depend on it (e.g. URL import).
 *
 * @returns {Promise<{ ok: boolean, status: number, body: object|null, error: string|null }>}
 *   Normalized outcome; `ok` is true only when processing responded 2xx.
 */
export async function getProcessingHealth() {
  return processingFetch("/health", {
    method: "GET",
    body: null,
  });
}
