import { advancedSearchEnabled } from "./search-backend-config.js";
import {
  loadEligibleDocument,
  loadEligiblePlaylistDocument,
  loadEligibleUserDocument,
} from "./search/document.js";
import {
  removePlaylistDocument as meiliRemovePlaylistDocument,
  removeUserDocument as meiliRemoveUserDocument,
  removeVideoDocument as meiliRemoveVideoDocument,
  syncPlaylistIndex as meiliSyncPlaylistIndex,
  syncUserIndex as meiliSyncUserIndex,
  syncVideoIndex as meiliSyncVideoIndex,
} from "./search/meilisearch.js";
import { OriginalUpload, User, UserPlaylist } from "./models/index.js";
import { logger } from "./logger.js";

/**
 * Default cron expression: once nightly, at 3am.
 *
 * @type {string}
 */
const DEFAULT_CRON = "0 3 * * *";

/**
 * Marks a video's search document as needing a (re)sync on the Meilisearch
 * backend's next nightly reindex run when it's still/newly eligible, or
 * removes it from the index immediately when it just became ineligible
 * (visibility left "public") — takedown correctness shouldn't wait for a
 * nightly batch, only additions/refreshes of still-eligible content should.
 * Never throws — errors are caught and logged.
 *
 * @param {number} originalUploadId ORIGINAL_UPLOADS id.
 * @returns {Promise<void>} Resolves once the attempt completes.
 */
export async function deferOrRemoveVideo(originalUploadId) {
  try {
    const doc = await loadEligibleDocument(originalUploadId);
    if (doc) {
      await OriginalUpload.update(
        { searchIndexStatus: "pending" },
        { where: { id: originalUploadId } },
      );
    } else {
      await meiliRemoveVideoDocument(originalUploadId);
    }
  } catch (err) {
    logger.error({ err }, `[search-reindex] deferOrRemoveVideo(${originalUploadId}) failed`);
  }
}

/**
 * Playlist equivalent of {@link deferOrRemoveVideo}.
 *
 * @param {number} playlistId USER_PLAYLISTS id.
 * @returns {Promise<void>} Resolves once the attempt completes.
 */
export async function deferOrRemovePlaylist(playlistId) {
  try {
    const doc = await loadEligiblePlaylistDocument(playlistId);
    if (doc) {
      await UserPlaylist.update(
        { searchIndexStatus: "pending" },
        { where: { id: playlistId } },
      );
    } else {
      await meiliRemovePlaylistDocument(playlistId);
    }
  } catch (err) {
    logger.error({ err }, `[search-reindex] deferOrRemovePlaylist(${playlistId}) failed`);
  }
}

/**
 * User equivalent of {@link deferOrRemoveVideo} (ineligible = locked).
 *
 * @param {number} userId USERS id.
 * @returns {Promise<void>} Resolves once the attempt completes.
 */
export async function deferOrRemoveUser(userId) {
  try {
    const doc = await loadEligibleUserDocument(userId);
    if (doc) {
      await User.update({ searchIndexStatus: "pending" }, { where: { id: userId } });
    } else {
      await meiliRemoveUserDocument(userId);
    }
  } catch (err) {
    logger.error({ err }, `[search-reindex] deferOrRemoveUser(${userId}) failed`);
  }
}

/**
 * Reindexes every `searchIndexStatus: "pending"` row of one model into
 * Meilisearch, flipping each to `"indexed"` afterward (conditioned on the
 * row still being `"pending"` at update time — cheap defensive guard against
 * two reindex runs overlapping; it doesn't detect a same-value re-dirty that
 * happens mid-sync, so an edit landing in the middle of this row's sync call
 * may not be reflected until the *next* run, which is an acceptable gap for
 * a nightly batch). A row whose sync throws is left `"pending"` and retried
 * next run — same per-row error isolation as `transcode-reconcile.js`.
 *
 * @private
 * @param {{label: string, model: import('sequelize').ModelStatic<import('sequelize').Model>, sync: (id: number) => Promise<void>}} options
 *   What to reindex and how.
 * @returns {Promise<void>} Resolves once every pending row has been attempted.
 */
async function reindexPending({ label, model, sync }) {
  const rows = await model.findAll({
    where: { searchIndexStatus: "pending" },
    attributes: ["id"],
  });
  logger.info(`[search-reindex] reindexing ${rows.length} pending ${label}(s)...`);

  for (const row of rows) {
    try {
      await sync(row.id);
      await model.update(
        { searchIndexStatus: "indexed" },
        { where: { id: row.id, searchIndexStatus: "pending" } },
      );
    } catch (err) {
      logger.error({ err }, `[search-reindex] failed to reindex ${label} ${row.id}`);
    }
  }
}

/**
 * Runs the full nightly reindex: every pending video, playlist, and user is
 * synced into Meilisearch and marked `"indexed"`. A no-op when the Meilisearch
 * backend isn't active — the default in-process backend stays instantly
 * consistent via `lib/search.js`'s unmodified sync path and never uses
 * `searchIndexStatus`.
 *
 * @returns {Promise<void>} Resolves once every table has been processed.
 */
export async function runSearchReindex() {
  if (!advancedSearchEnabled()) {
    logger.info("[search-reindex] ENABLE_ADVANCED_SEARCH is not set to true; nothing to do.");
    return;
  }

  await reindexPending({ label: "video", model: OriginalUpload, sync: meiliSyncVideoIndex });
  await reindexPending({ label: "playlist", model: UserPlaylist, sync: meiliSyncPlaylistIndex });
  await reindexPending({ label: "user", model: User, sync: meiliSyncUserIndex });
}

/**
 * Reads nightly-reindex configuration from the environment.
 *
 * @returns {{ cron: string, enabled: boolean }} Scheduler settings.
 */
export function getSearchReindexConfig() {
  const cron = (process.env.SEARCH_REINDEX_CRON || DEFAULT_CRON).trim();
  const disabled = ["0", "false", "off", "no"].includes(
    String(process.env.SEARCH_REINDEX_ENABLED || "true")
      .trim()
      .toLowerCase(),
  );
  return { cron, enabled: !disabled };
}

/**
 * Starts the node-cron scheduler for the nightly Meilisearch reindex. A
 * no-op (logs and returns null) when the Meilisearch backend isn't active —
 * the default in-process backend has nothing for this cron to do.
 *
 * @returns {Promise<import('node-cron').ScheduledTask | null>} Started task, or
 *   null when not applicable, disabled, or the cron expression is invalid.
 */
export async function startSearchReindexCron() {
  if (!advancedSearchEnabled()) {
    logger.info("[search-reindex] advanced search is disabled; nightly reindex cron not needed");
    return null;
  }

  const config = getSearchReindexConfig();
  if (!config.enabled) {
    logger.info("[search-reindex] disabled via SEARCH_REINDEX_ENABLED");
    return null;
  }

  const cron = await import("node-cron");
  if (!cron.validate(config.cron)) {
    logger.error(`[search-reindex] invalid SEARCH_REINDEX_CRON: ${config.cron}`);
    return null;
  }

  const task = cron.schedule(config.cron, () => {
    void runSearchReindex().catch((err) => {
      logger.error({ err }, "[search-reindex] run failed");
    });
  });

  logger.info(`[search-reindex] scheduled (${config.cron})`);
  return task;
}
