import { Router } from "express";
import { csrfProtection } from "../lib/auth/csrf.js";
import { requireAuth } from "../lib/auth/require-auth.js";
import { CastServiceError } from "../lib/cast/errors.js";
import { castMediaBaseUrl } from "../lib/cast-devices/config.js";
import { controlDevice, playOnDevice } from "../lib/cast-devices/controller.js";
import { discoverCastDevices, findCastDevice } from "../lib/cast-devices/discovery.js";
import { canViewVideo } from "../lib/video-access.js";
import {
  loadAccessGrant,
  loadRenditions,
  loadUploadWithMetadataByIdentifier,
} from "./videos.js";
import { logger } from "../lib/logger.js";

/**
 * Transport commands accepted by castDeviceControl.
 *
 * @type {string[]}
 */
const CONTROL_COMMANDS = ["play", "pause", "stop"];

/**
 * Sends the standard error envelope for a {@link CastServiceError}.
 *
 * @param {import('express').Response} res Express response.
 * @param {unknown} err The caught error.
 * @returns {boolean} True when `err` was handled.
 */
function handleServiceError(res, err) {
  if (err instanceof CastServiceError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return true;
  }
  return false;
}

/**
 * Builds the device-casting router: discovering Chromecasts on the local
 * network and pushing a video to one. Unlike browser-side casting (the Remote
 * Playback API), the server talks to the device directly, so this works in
 * every browser - including Firefox, which implements no casting API at all.
 *
 * @returns {import('express').Router} Configured router.
 */
export function createCastDevicesRouter() {
  const router = Router();
  router.use(csrfProtection);

  /**
   * Lists Chromecasts visible on the local network.
   * GET /api/v1/cast-devices
   * Auth: required.
   *
   * @openapi
   * /api/v1/cast-devices:
   *   get:
   *     tags: [Cast]
   *     summary: List Chromecast devices on the local network
   *     operationId: listCastDevices
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       "200":
   *         description: Discovered devices
   *       "401":
   *         description: Not authenticated
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the device list or an error response.
   */
  router.get("/cast-devices", requireAuth, async (req, res) => {
    try {
      res.status(200).json({ items: await discoverCastDevices() });
    } catch (err) {
      logger.error({ err }, "listCastDevices failed");
      res.status(500).json({
        error: "internal_error",
        message: "Failed to discover cast devices.",
      });
    }
  });

  /**
   * Plays a video on a device.
   * POST /api/v1/cast-devices/:id/play
   * Auth: required; the caller must be able to view the video.
   *
   * @openapi
   * /api/v1/cast-devices/{id}/play:
   *   post:
   *     tags: [Cast]
   *     summary: Play a video on a cast device
   *     operationId: playOnCastDevice
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [videoId]
   *             properties:
   *               videoId:
   *                 type: string
   *     responses:
   *       "200":
   *         description: Playback started
   *       "400":
   *         description: Missing videoId
   *       "404":
   *         description: Device or video not found
   *       "502":
   *         description: The device refused the request
   *       "504":
   *         description: The device could not be reached
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the device status or an error response.
   */
  router.post("/cast-devices/:id/play", requireAuth, async (req, res) => {
    try {
      const videoIdentifier = req.body?.videoId;
      if (!videoIdentifier) {
        res.status(400).json({ error: "invalid_body", message: "videoId is required." });
        return;
      }

      const device = await findCastDevice(String(req.params.id));
      if (!device) {
        res.status(404).json({ error: "not_found", message: "Cast device not found." });
        return;
      }

      const found = await loadUploadWithMetadataByIdentifier(String(videoIdentifier));
      if (!found) {
        res.status(404).json({ error: "not_found", message: "Video not found." });
        return;
      }
      const { upload, metadata } = found;
      const hasGrant = await loadAccessGrant(upload.id, req.user.id);
      if (!canViewVideo(req.user, req.authRole, upload, metadata, Boolean(hasGrant))) {
        res.status(404).json({ error: "not_found", message: "Video not found." });
        return;
      }

      // Highest-quality rendition first; the device pulls this itself, so the
      // browser's current quality selection is irrelevant here.
      const renditions = await loadRenditions(upload);
      const rendition = renditions[0];
      if (!rendition) {
        res.status(409).json({
          error: "not_playable",
          message: "This video has no playable rendition yet.",
        });
        return;
      }

      const status = await playOnDevice({
        device,
        mediaUrl: `${castMediaBaseUrl()}${rendition.streamUrl}`,
        title: metadata.title,
        contentType: rendition.mimeType || "video/mp4",
      });

      res.status(200).json({ device, status: status ?? null });
    } catch (err) {
      if (handleServiceError(res, err)) return;
      logger.error({ err }, "playOnCastDevice failed");
      res.status(500).json({ error: "internal_error", message: "Failed to cast to the device." });
    }
  });

  /**
   * Sends a transport command to a device.
   * POST /api/v1/cast-devices/:id/control
   * Auth: required.
   *
   * @openapi
   * /api/v1/cast-devices/{id}/control:
   *   post:
   *     tags: [Cast]
   *     summary: Control playback on a cast device
   *     operationId: controlCastDevice
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [command]
   *             properties:
   *               command:
   *                 type: string
   *                 enum: [play, pause, stop]
   *     responses:
   *       "200":
   *         description: Command accepted
   *       "400":
   *         description: Unknown command
   *       "404":
   *         description: Device not found
   *       "409":
   *         description: Nothing is playing on that device
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the device status or an error response.
   */
  router.post("/cast-devices/:id/control", requireAuth, async (req, res) => {
    try {
      const command = String(req.body?.command ?? "");
      if (!CONTROL_COMMANDS.includes(command)) {
        res.status(400).json({
          error: "invalid_body",
          message: `command must be one of ${CONTROL_COMMANDS.join(", ")}.`,
        });
        return;
      }

      const device = await findCastDevice(String(req.params.id));
      if (!device) {
        res.status(404).json({ error: "not_found", message: "Cast device not found." });
        return;
      }

      const status = await controlDevice({ device, command });
      res.status(200).json({ device, status: status ?? null });
    } catch (err) {
      if (handleServiceError(res, err)) return;
      logger.error({ err }, "controlCastDevice failed");
      res.status(500).json({
        error: "internal_error",
        message: "Failed to control the cast device.",
      });
    }
  });

  return router;
}
