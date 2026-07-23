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
 * One job descriptor in a batch `POST /transcode` request.
 *
 * @typedef {object} TranscodeBatchJob
 * @property {string} jobId Stable BullMQ job id (FILE_VERSIONS.uuid_name).
 * @property {string} outputFilename Basename under `/media/transcoded`.
 * @property {TranscodeProfilePayload} profile Transcode profile fields.
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
    };
    if (options.body != null) {
      init.headers = { "Content-Type": "application/json" };
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
