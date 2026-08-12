/**
 * Feature flags gating webapi's use of the processing service (transcodes,
 * thumbnails, and yt-dlp URL imports), so a deployment can run without a
 * processing container at all. Unlike `livestream-config.js`/
 * `search-backend-config.js` (opt-in betas, default off), both flags here
 * default *on* to preserve existing behavior for deployments that don't set
 * them — mirroring `ENABLE_TRANSCODING`'s default in `processing/.env.example`.
 * When disabled, callers must skip the outbound processing-service request
 * entirely rather than let it fail against a stopped/unreachable container.
 */

/**
 * Returns whether webapi should enqueue transcode/thumbnail jobs with the
 * processing service. When false, uploads/imports finish immediately with
 * only the original file available (no FILE_VERSIONS renditions, no
 * generated thumbnail) and never contact processing.
 *
 * @returns {boolean} True unless ENABLE_TRANSCODING is explicitly "false".
 */
export function transcodingEnabled() {
  return String(process.env.ENABLE_TRANSCODING ?? "true").toLowerCase() !== "false";
}

/**
 * Returns whether `POST /videos/import` (yt-dlp URL import) is available.
 * When false, the route rejects requests before creating any ORIGINAL_UPLOADS
 * row or contacting the processing service's `/download` endpoint.
 *
 * @returns {boolean} True unless ENABLE_VIDEO_IMPORTS is explicitly "false".
 */
export function videoImportsEnabled() {
  return String(process.env.ENABLE_VIDEO_IMPORTS ?? "true").toLowerCase() !== "false";
}
