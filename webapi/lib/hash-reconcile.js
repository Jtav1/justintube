import { duplicateUploadDetectionEnabled } from "./processing-features-config.js";
import { retryFailedHashJobs } from "./processing-client.js";
import { logger } from "./logger.js";

/**
 * Default cron expression: once nightly, at 3am.
 *
 * @type {string}
 */
const DEFAULT_CRON = "0 3 * * *";

/**
 * Reads nightly hash-reconcile configuration from the environment.
 *
 * @returns {{ cron: string, enabled: boolean }} Scheduler settings.
 */
export function getHashReconcileConfig() {
  const cron = (process.env.DUPLICATE_HASH_RECONCILE_CRON || DEFAULT_CRON).trim();
  const disabled = ["0", "false", "off", "no"].includes(
    String(process.env.DUPLICATE_HASH_RECONCILE_ENABLED || "true")
      .trim()
      .toLowerCase(),
  );
  return { cron, enabled: !disabled };
}

/**
 * Asks the processing service to retry every failed duplicate-upload
 * content-hash job still sitting in its Redis queue (it never removes a
 * failed hash job on its own - see `removeOnFail: false` in
 * `processing/lib/queue.js`), so a transient ffprobe failure isn't left
 * unresolved forever - except a job that's already run 7 times
 * (`MAX_HASH_JOB_RUNS`), which processing discards outright instead of
 * retrying again. A no-op when duplicate-upload detection itself is
 * disabled, since nothing would have enqueued a hash job in the first place.
 *
 * @returns {Promise<{
 *   retried: string[],
 *   discarded: string[],
 *   failed: Array<{ jobId: string, error: string }>
 * }>} Job ids retried, job ids discarded after reaching the run cap, and any
 *   that errored; all empty when the feature is disabled or the processing
 *   call itself failed.
 */
export async function runHashReconcile() {
  if (!duplicateUploadDetectionEnabled()) {
    logger.info(
      "[hash-reconcile] ENABLE_DUPLICATE_UPLOAD_DETECTION is not set to true; nothing to do.",
    );
    return { retried: [], discarded: [], failed: [] };
  }

  const result = await retryFailedHashJobs();
  if (!result.ok) {
    logger.error({ error: result.error }, "[hash-reconcile] retry-failed-hashes request failed");
    return { retried: [], discarded: [], failed: [] };
  }

  const retried = Array.isArray(result.body?.retried) ? result.body.retried : [];
  const discarded = Array.isArray(result.body?.discarded) ? result.body.discarded : [];
  const failed = Array.isArray(result.body?.failed) ? result.body.failed : [];

  if (retried.length > 0) {
    logger.info(`[hash-reconcile] retried ${retried.length} failed hash job(s): ${retried.join(", ")}`);
  }
  if (discarded.length > 0) {
    logger.warn(
      `[hash-reconcile] discarded ${discarded.length} hash job(s) after reaching the run cap: ${discarded.join(", ")}`,
    );
  }
  for (const entry of failed) {
    logger.error({ error: entry.error }, `[hash-reconcile] failed to retry hash job ${entry.jobId}`);
  }
  if (retried.length === 0 && discarded.length === 0 && failed.length === 0) {
    logger.info("[hash-reconcile] no failed hash jobs to retry.");
  }

  return { retried, discarded, failed };
}

/**
 * Starts the node-cron scheduler for the nightly duplicate-hash reconcile. A
 * no-op (logs and returns null) when duplicate-upload detection is disabled
 * - there's nothing this cron could ever find to retry.
 *
 * @returns {Promise<import('node-cron').ScheduledTask | null>} Started task, or
 *   null when not applicable, disabled, or the cron expression is invalid.
 */
export async function startHashReconcileCron() {
  if (!duplicateUploadDetectionEnabled()) {
    logger.info(
      "[hash-reconcile] duplicate-upload detection is disabled; nightly reconcile cron not needed",
    );
    return null;
  }

  const config = getHashReconcileConfig();
  if (!config.enabled) {
    logger.info("[hash-reconcile] disabled via DUPLICATE_HASH_RECONCILE_ENABLED");
    return null;
  }

  const cron = await import("node-cron");
  if (!cron.validate(config.cron)) {
    logger.error(`[hash-reconcile] invalid DUPLICATE_HASH_RECONCILE_CRON: ${config.cron}`);
    return null;
  }

  const task = cron.schedule(config.cron, () => {
    void runHashReconcile().catch((err) => {
      logger.error({ err }, "[hash-reconcile] run failed");
    });
  });

  logger.info(`[hash-reconcile] scheduled (${config.cron})`);
  return task;
}
