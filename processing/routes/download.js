import { Router } from "express";
import {
  DownloadValidationError,
  downloadAudioOnly,
  downloadFormat,
  downloadPlaylist,
  downloadUrl,
  parseYtDlpOptions,
  probePlaylist,
  probeUrl,
  validateOptionalLimit,
} from "../lib/download.js";
import { logger } from "../lib/logger.js";

/**
 * Sends a `DownloadValidationError` as `400`, or any other error as `500`,
 * matching this router's existing `{ success, error }` envelope.
 *
 * @param {import('express').Response} res Express response.
 * @param {string} label Log-line label (e.g. `"[probe]"`).
 * @param {unknown} err Caught error.
 * @returns {void} Sends the JSON error payload.
 */
function sendDownloadError(res, label, err) {
  if (err instanceof DownloadValidationError) {
    logger.warn(`${label} request rejected: ${err.message}`);
    res.status(400).json({ success: false, error: err.message });
    return;
  }

  const message = err instanceof Error ? err.message : "request failed";
  logger.error({ message }, `${label} request failed`);
  res.status(500).json({ success: false, error: message });
}

/**
 * Creates the download router (`POST /` when mounted at `/download`, plus
 * sibling probe/playlist routes). `cookies`/`rateLimit`/`retries` in the
 * request body are never logged — only the URL is.
 *
 * @returns {import('express').Router} Router handling URL download requests.
 */
export function createDownloadRouter() {
  const router = Router();

  /**
   * Downloads a remote video via yt-dlp and returns the saved basename.
   *
   * @param {import('express').Request} req Incoming request with `{ url, cookies?, rateLimit?, retries? }`.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends JSON success or error payload.
   */
  router.post("/", async (req, res) => {
    logger.info(`[download] request received: ${req.body?.url}`);
    try {
      const options = parseYtDlpOptions(req.body);
      const { filename, hasVideo } = await downloadUrl(req.body?.url, options);
      logger.info(`[download] request succeeded: ${filename} (hasVideo=${hasVideo})`);
      res.status(200).json({ success: true, filename, hasVideo });
    } catch (err) {
      sendDownloadError(res, "[download]", err);
    }
  });

  /**
   * Downloads only the audio from a URL (no video, no muxed container) and
   * returns the saved basename.
   *
   * @param {import('express').Request} req Incoming request with
   *   `{ url, audioFormat?, cookies?, rateLimit?, retries? }`.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends JSON success or error payload.
   */
  router.post("/audio", async (req, res) => {
    logger.info(`[download-audio] request received: ${req.body?.url}`);
    try {
      const options = parseYtDlpOptions(req.body);
      const { filename } = await downloadAudioOnly(req.body?.url, {
        ...options,
        audioFormat: req.body?.audioFormat,
      });
      logger.info(`[download-audio] request succeeded: ${filename}`);
      res.status(200).json({ success: true, filename });
    } catch (err) {
      sendDownloadError(res, "[download-audio]", err);
    }
  });

  /**
   * Downloads a URL in a specific, caller-chosen format id (re-validated
   * against a live probe — see `downloadFormat`) and returns the saved
   * basename.
   *
   * @param {import('express').Request} req Incoming request with
   *   `{ url, formatId, cookies?, rateLimit?, retries? }`.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends JSON success or error payload.
   */
  router.post("/format", async (req, res) => {
    logger.info(
      `[download-format] request received: ${req.body?.url} (formatId=${req.body?.formatId})`,
    );
    try {
      const options = parseYtDlpOptions(req.body);
      const { filename, hasVideo } = await downloadFormat(
        req.body?.url,
        req.body?.formatId,
        options,
      );
      logger.info(`[download-format] request succeeded: ${filename} (hasVideo=${hasVideo})`);
      res.status(200).json({ success: true, filename, hasVideo });
    } catch (err) {
      sendDownloadError(res, "[download-format]", err);
    }
  });

  /**
   * Fetches metadata for a URL (title, duration, thumbnail, available
   * formats, …) without downloading anything, so a caller can preview an
   * import before committing to `POST /download`.
   *
   * @param {import('express').Request} req Incoming request with `{ url, cookies?, rateLimit?, retries? }`.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends JSON success or error payload.
   */
  router.post("/probe", async (req, res) => {
    logger.info(`[probe] request received: ${req.body?.url}`);
    try {
      const options = parseYtDlpOptions(req.body);
      const info = await probeUrl(req.body?.url, options);
      logger.info(`[probe] request succeeded: ${req.body?.url}`);
      res.status(200).json({ success: true, ...info });
    } catch (err) {
      sendDownloadError(res, "[probe]", err);
    }
  });

  /**
   * Enumerates a playlist/channel URL's entries without downloading anything.
   *
   * @param {import('express').Request} req Incoming request with
   *   `{ url, limit?, cookies?, rateLimit?, retries? }`.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends JSON success or error payload.
   */
  router.post("/playlist/probe", async (req, res) => {
    logger.info(`[playlist-probe] request received: ${req.body?.url}`);
    try {
      const options = parseYtDlpOptions(req.body);
      const limit = validateOptionalLimit(req.body?.limit);
      const result = await probePlaylist(req.body?.url, { ...options, limit });
      logger.info(`[playlist-probe] request succeeded: ${req.body?.url}`);
      res.status(200).json({ success: true, ...result });
    } catch (err) {
      sendDownloadError(res, "[playlist-probe]", err);
    }
  });

  /**
   * Downloads every entry (up to a server-side cap) of a playlist/channel
   * URL sequentially, reporting per-entry success/failure.
   *
   * @param {import('express').Request} req Incoming request with
   *   `{ url, limit?, cookies?, rateLimit?, retries? }`.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends JSON success or error payload.
   */
  router.post("/playlist", async (req, res) => {
    logger.info(`[playlist-download] request received: ${req.body?.url}`);
    try {
      const options = parseYtDlpOptions(req.body);
      const limit = validateOptionalLimit(req.body?.limit);
      const result = await downloadPlaylist(req.body?.url, { ...options, limit });
      logger.info(
        `[playlist-download] request succeeded: ${result.succeeded}/${result.total} succeeded`,
      );
      res.status(200).json({ success: true, ...result });
    } catch (err) {
      sendDownloadError(res, "[playlist-download]", err);
    }
  });

  return router;
}
