import { Router } from "express";
import {
  applyFileVersionComplete,
  applyFileVersionFailed,
  findFileVersionByUuid,
} from "../lib/file-versions.js";

/**
 * Express middleware that requires `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`.
 *
 * @param {import('express').Request} req Incoming request.
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Continues when authorized.
 * @returns {void} Sends 401 when the token is missing or mismatched.
 */
function requireInternalToken(req, res, next) {
  const expected = process.env.INTERNAL_SERVICE_TOKEN || "";
  if (!expected) {
    res.status(503).json({
      error: "internal_auth_unconfigured",
      message: "INTERNAL_SERVICE_TOKEN is not configured.",
    });
    return;
  }

  const header = String(req.headers.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const provided = match ? match[1].trim() : "";
  if (!provided || provided !== expected) {
    res.status(401).json({
      error: "unauthorized",
      message: "Valid internal service token required.",
    });
    return;
  }

  next();
}

/**
 * Builds the router for processing → API file-version lifecycle callbacks.
 *
 * @returns {import('express').Router} Router mounted at `/internal`.
 */
export function createInternalFileVersionsRouter() {
  const router = Router();
  router.use(requireInternalToken);

  /**
   * Marks a file version complete and stores output metadata from processing.
   *
   * @param {import('express').Request} req Request with `uuid` param + body fields.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 JSON, 404, or error.
   */
  router.post("/file-versions/:uuid/complete", async (req, res) => {
    const uuid = String(req.params.uuid || "").trim();
    if (!uuid) {
      res.status(400).json({
        error: "missing_uuid",
        message: "uuid is required.",
      });
      return;
    }

    const version = await findFileVersionByUuid(uuid);
    if (!version) {
      res.status(404).json({
        error: "not_found",
        message: "File version not found.",
      });
      return;
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    await applyFileVersionComplete(version, {
      fileSizeBytes:
        typeof body.fileSizeBytes === "number" ? body.fileSizeBytes : undefined,
      videoWidth:
        body.videoWidth === null || typeof body.videoWidth === "number"
          ? body.videoWidth
          : undefined,
      videoHeight:
        body.videoHeight === null || typeof body.videoHeight === "number"
          ? body.videoHeight
          : undefined,
      resolution:
        body.resolution === null || typeof body.resolution === "string"
          ? body.resolution
          : undefined,
      storagePath:
        typeof body.storagePath === "string" ? body.storagePath : undefined,
      mimeType:
        body.mimeType === null || typeof body.mimeType === "string"
          ? body.mimeType
          : undefined,
    });

    res.status(200).json({
      success: true,
      uuidName: version.uuidName,
      status: "complete",
    });
  });

  /**
   * Marks a file version failed after a processing error.
   *
   * @param {import('express').Request} req Request with `uuid` param + optional error.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 JSON, 404, or error.
   */
  router.post("/file-versions/:uuid/fail", async (req, res) => {
    const uuid = String(req.params.uuid || "").trim();
    if (!uuid) {
      res.status(400).json({
        error: "missing_uuid",
        message: "uuid is required.",
      });
      return;
    }

    const version = await findFileVersionByUuid(uuid);
    if (!version) {
      res.status(404).json({
        error: "not_found",
        message: "File version not found.",
      });
      return;
    }

    const message =
      req.body && typeof req.body.error === "string"
        ? req.body.error
        : "transcode failed";

    console.error(
      `[file-versions] transcode failed for upload ${version.originalUploadId} uuid ${uuid}:`,
      message,
    );

    await applyFileVersionFailed(version);

    res.status(200).json({
      success: true,
      uuidName: version.uuidName,
      status: "failed",
    });
  });

  return router;
}
