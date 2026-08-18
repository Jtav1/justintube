/**
 * Error thrown by `lib/cast/queue-service.js` functions to signal a specific,
 * HTTP-mappable failure (missing session/video/playlist, forbidden action,
 * invalid input, an ended session). `routes/cast.js` and
 * `lib/cast/realtime.js` both catch this and translate `status`/`code`/
 * `message` into the house `{error, message}` response envelope (or a
 * socket-side error payload), so validation/authorization logic lives once
 * in the service layer instead of being duplicated per transport.
 */
export class CastServiceError extends Error {
  /**
   * @param {number} status HTTP status code this error maps to.
   * @param {string} code Snake_case error code (house convention).
   * @param {string} message Human-readable message.
   */
  constructor(status, code, message) {
    super(message);
    this.name = "CastServiceError";
    this.status = status;
    this.code = code;
  }
}
