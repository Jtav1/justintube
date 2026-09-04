import { Op } from "sequelize";
import {
  applyFileVersionComplete,
  applyFileVersionFailed,
  loadTranscodeProfilePayload,
} from "./file-versions.js";
import { FileVersion, OriginalUpload } from "./models/index.js";
import {
  getTranscodeJobStatus,
  removeTranscodeJob,
  requestTranscodeBatch,
} from "./processing-client.js";
import { transcodingEnabled } from "./processing-features-config.js";
import { logger } from "./logger.js";

/**
 * Default cron expression: every 5 minutes.
 *
 * @type {string}
 */
const DEFAULT_CRON = "*/5 * * * *";

/**
 * Default age (minutes) before a pending/processing row is considered stale.
 *
 * @type {number}
 */
const DEFAULT_STALE_MINUTES = 15;

/**
 * Reads reconcile configuration from the environment.
 *
 * @returns {{ cron: string, staleMinutes: number, enabled: boolean }}
 *   Scheduler settings.
 */
export function getReconcileConfig() {
  const cron = (process.env.TRANSCODE_RECONCILE_CRON || DEFAULT_CRON).trim();
  const staleMinutes =
    Number(process.env.TRANSCODE_RECONCILE_STALE_MINUTES) ||
    DEFAULT_STALE_MINUTES;
  const disabled = ["0", "false", "off", "no"].includes(
    String(process.env.TRANSCODE_RECONCILE_ENABLED || "true")
      .trim()
      .toLowerCase(),
  );
  return { cron, staleMinutes, enabled: !disabled };
}

/**
 * Reconciles a single stale file version against BullMQ job state.
 *
 * @param {import('sequelize').Model} version Stale FileVersion row.
 * @returns {Promise<{ action: string, uuidName: string }>} Action taken.
 */
export async function reconcileFileVersion(version) {
  const uuidName = version.uuidName;
  const statusResult = await getTranscodeJobStatus(uuidName);

  if (statusResult.ok && statusResult.body) {
    const state = statusResult.body.state;

    if (state === "completed") {
      const rv =
        statusResult.body.returnvalue &&
        typeof statusResult.body.returnvalue === "object"
          ? statusResult.body.returnvalue
          : {};
      await applyFileVersionComplete(version, {
        fileSizeBytes:
          typeof rv.fileSizeBytes === "number" ? rv.fileSizeBytes : undefined,
        videoWidth: rv.videoWidth ?? undefined,
        videoHeight: rv.videoHeight ?? undefined,
        resolution: rv.resolution ?? undefined,
        storagePath:
          typeof rv.storagePath === "string"
            ? rv.storagePath
            : version.storagePath,
        mimeType: rv.mimeType ?? undefined,
      });
      return { action: "healed_complete", uuidName };
    }

    if (state === "failed") {
      logger.error(
        { reason: statusResult.body.failedReason || "unknown failure" },
        `[reconcile] transcode job failed for file version ${uuidName} (upload ${version.originalUploadId})`,
      );
      await applyFileVersionFailed(version);
      const removed = await removeTranscodeJob(uuidName);
      if (!removed.ok && removed.status !== 404) {
        logger.error({ error: removed.error }, `[reconcile] failed to remove job ${uuidName} from queue`);
      }
      return { action: "marked_failed_removed", uuidName };
    }

    return { action: "noop_in_flight", uuidName };
  }

  if (statusResult.status === 404 || statusResult.status === 0) {
    if (!version.transcodeProfileId) {
      logger.error(`[reconcile] cannot re-enqueue ${uuidName}: missing transcodeProfileId`);
      await applyFileVersionFailed(version);
      return { action: "marked_failed_no_profile", uuidName };
    }

    const profile = await loadTranscodeProfilePayload(version.transcodeProfileId);
    if (!profile) {
      logger.error(`[reconcile] cannot re-enqueue ${uuidName}: profile ${version.transcodeProfileId} not found`);
      await applyFileVersionFailed(version);
      return { action: "marked_failed_no_profile", uuidName };
    }

    const parent = await OriginalUpload.findByPk(version.originalUploadId);
    if (!parent?.storagePath) {
      logger.error(`[reconcile] cannot re-enqueue ${uuidName}: original upload missing`);
      await applyFileVersionFailed(version);
      return { action: "marked_failed_no_upload", uuidName };
    }

    const inputFilename = String(parent.storagePath).replace(/^original\//, "");
    const outputFilename = String(version.storagePath).replace(
      /^transcoded\//,
      "",
    );
    const enqueue = await requestTranscodeBatch({
      filename: inputFilename,
      jobs: [
        {
          jobId: uuidName,
          outputFilename,
          profile,
        },
      ],
    });

    if (!enqueue.ok) {
      logger.error({ error: enqueue.error }, `[reconcile] re-enqueue failed for ${uuidName}`);
      await applyFileVersionFailed(version);
      const removed = await removeTranscodeJob(uuidName);
      if (!removed.ok && removed.status !== 404) {
        logger.error(
          { error: removed.error },
          `[reconcile] failed to remove job ${uuidName} after re-enqueue failure`,
        );
      }
      return { action: "marked_failed_reenqueue", uuidName };
    }

    if (version.status === "pending") {
      await version.update({ status: "processing" });
    }
    return { action: "reenqueued", uuidName };
  }

  logger.error({ error: statusResult.error }, `[reconcile] unexpected status lookup for ${uuidName}`);
  return { action: "noop_error", uuidName };
}

/**
 * Finds stale pending/processing file versions and reconciles each. A no-op
 * when transcoding is disabled deployment-wide (`ENABLE_TRANSCODING=false`)
 * — there is no processing service to check job status against or
 * re-enqueue onto, so this must never attempt either. Any stale rows left
 * behind from before transcoding was disabled simply stay untouched rather
 * than being marked failed; re-enabling transcoding lets a later run pick
 * them back up.
 *
 * @param {object} [options] Override stale window for tests.
 * @param {number} [options.staleMinutes] Minutes before a row is stale.
 * @returns {Promise<Array<{ action: string, uuidName: string }>>} Actions taken.
 */
export async function runTranscodeReconcile(options = {}) {
  if (!transcodingEnabled()) {
    return [];
  }

  const { staleMinutes } = { ...getReconcileConfig(), ...options };
  const cutoff = new Date(Date.now() - staleMinutes * 60_000);

  const versions = await FileVersion.findAll({
    where: {
      status: { [Op.in]: ["pending", "processing"] },
      createdAt: { [Op.lt]: cutoff },
    },
  });

  /** @type {Array<{ action: string, uuidName: string }>} */
  const results = [];
  for (const version of versions) {
    try {
      results.push(await reconcileFileVersion(version));
    } catch (err) {
      logger.error({ err }, `[reconcile] unexpected error for ${version.uuidName}`);
      results.push({ action: "error", uuidName: version.uuidName });
    }
  }
  return results;
}

/**
 * Starts the node-cron scheduler for transcode reconciliation.
 *
 * @returns {Promise<import('node-cron').ScheduledTask | null>} Started task, or
 *   null when disabled or the cron expression is invalid.
 */
export async function startTranscodeReconcileCron() {
  const config = getReconcileConfig();
  if (!config.enabled) {
    logger.info("[reconcile] disabled via TRANSCODE_RECONCILE_ENABLED");
    return null;
  }

  const cron = await import("node-cron");
  if (!cron.validate(config.cron)) {
    logger.error(`[reconcile] invalid TRANSCODE_RECONCILE_CRON: ${config.cron}`);
    return null;
  }

  const task = cron.schedule(config.cron, () => {
    void runTranscodeReconcile().catch((err) => {
      logger.error({ err }, "[reconcile] run failed");
    });
  });

  logger.info(`[reconcile] scheduled (${config.cron}, stale>${config.staleMinutes}m)`);
  return task;
}
