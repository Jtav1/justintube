import { Router } from "express";
import {
  DownloadValidationError,
  downloadUrl,
} from "../lib/download.js";

/**
 * Creates the download router (`POST /` when mounted at `/download`).
 *
 * @returns {import('express').Router} Router handling URL download requests.
 */
export function createDownloadRouter() {
  const router = Router();

  /**
   * Downloads a remote video via yt-dlp and returns the saved basename.
   *
   * @param {import('express').Request} req Incoming request with `{ url }`.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends JSON success or error payload.
   */
  router.post("/", async (req, res) => {
    try {
      const filename = await downloadUrl(req.body?.url);
      res.status(200).json({ success: true, filename });
    } catch (err) {
      if (err instanceof DownloadValidationError) {
        res.status(400).json({ success: false, error: err.message });
        return;
      }

      const message =
        err instanceof Error ? err.message : "download failed";
      res.status(500).json({ success: false, error: message });
    }
  });

  return router;
}
