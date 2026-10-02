import { Op } from "sequelize";
import { OriginalUpload } from "./models/index.js";
import { rollbackFailedImport } from "../routes/uploads.js";
import { logger } from "./logger.js";

/**
 * Default cron expression: every 15 minutes.
 *
 * @type {string}
 */
const DEFAULT_CRON = "*/15 * * * *";

/**
 * Default age (minutes) before a placeholder "downloading" row is considered
 * abandoned. Generous relative to `DOWNLOAD_REQUEST_TIMEOUT_MS`
 * (processing-client.js) so an import that's still genuinely in flight is
 * never swept up.
 *
 * @type {number}
 */
const DEFAULT_STALE_MINUTES = 30;

/**
 * Reads stale-import reconcile configuration from the environment.
 *
 * @returns {{ cron: string, staleMinutes: number, enabled: boolean }}
 *   Scheduler settings.
 */
export function getImportReconcileConfig() {
  const cron = (process.env.IMPORT_RECONCILE_CRON || DEFAULT_CRON).trim();
  const staleMinutes =
    Number(process.env.IMPORT_RECONCILE_STALE_MINUTES) || DEFAULT_STALE_MINUTES;
  const disabled = ["0", "false", "off", "no"].includes(
    String(process.env.IMPORT_RECONCILE_ENABLED || "true")
      .trim()
      .toLowerCase(),
  );
  return { cron, staleMinutes, enabled: !disabled };
}

/**
 * Finds `ORIGINAL_UPLOADS` placeholder rows left behind by a
 * `POST /videos/import` whose fire-and-forget `continueImport` never
 * finished — most plausibly because webapi itself restarted mid-download,
 * before its own try/catch could roll the row back — and rolls each one back
 * via {@link rollbackFailedImport}. A row only ever has `status:
 * "downloading"` with an empty `storagePath` while `continueImport` is
 * actively running (see `routes/uploads.js`); surviving past the stale
 * window means that run is gone and the row is orphaned.
 *
 * @param {object} [options] Override stale window for tests.
 * @param {number} [options.staleMinutes] Minutes before a row is stale.
 * @returns {Promise<Array<{ action: string, videoId: string }>>} Actions taken.
 */
export async function runImportReconcile(options = {}) {
  const { staleMinutes } = { ...getImportReconcileConfig(), ...options };
  const cutoff = new Date(Date.now() - staleMinutes * 60_000);

  const uploads = await OriginalUpload.findAll({
    where: {
      status: "downloading",
      storagePath: "",
      uploadedAt: { [Op.lt]: cutoff },
    },
  });

  /** @type {Array<{ action: string, videoId: string }>} */
  const results = [];
  for (const upload of uploads) {
    try {
      await rollbackFailedImport(
        upload,
        `Import abandoned: still "downloading" after ${staleMinutes} minutes with no completed download.`,
      );
      results.push({ action: "rolled_back", videoId: upload.videoId });
    } catch (err) {
      logger.error({ err }, `[import-reconcile] failed to roll back stale import ${upload.videoId}`);
      results.push({ action: "error", videoId: upload.videoId });
    }
  }
  return results;
}

/**
 * Starts the node-cron scheduler for stale-import reconciliation.
 *
 * @returns {Promise<import('node-cron').ScheduledTask | null>} Started task, or
 *   null when disabled or the cron expression is invalid.
 */
export async function startImportReconcileCron() {
  const config = getImportReconcileConfig();
  if (!config.enabled) {
    logger.info("[import-reconcile] disabled via IMPORT_RECONCILE_ENABLED");
    return null;
  }

  const cron = await import("node-cron");
  if (!cron.validate(config.cron)) {
    logger.error(`[import-reconcile] invalid IMPORT_RECONCILE_CRON: ${config.cron}`);
    return null;
  }

  const task = cron.schedule(config.cron, () => {
    void runImportReconcile().catch((err) => {
      logger.error({ err }, "[import-reconcile] run failed");
    });
  });

  logger.info(`[import-reconcile] scheduled (${config.cron}, stale>${config.staleMinutes}m)`);
  return task;
}
