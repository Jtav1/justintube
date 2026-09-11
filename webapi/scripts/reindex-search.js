import { runSearchReindex } from "../lib/search-reindex.js";

/**
 * On-demand trigger for the same nightly reindex logic `startSearchReindexCron`
 * schedules (`lib/search-reindex.js`) — syncs every `searchIndexStatus:
 * "pending"` video, playlist, and user into Meilisearch and marks each
 * `"indexed"`. A no-op (with a log line) when `ENABLE_ADVANCED_SEARCH` isn't
 * set to `true`, since the default in-process backend never uses this status
 * column. Useful right after deploying this feature, or for disaster
 * recovery after wiping the Meilisearch volume, without waiting for the
 * scheduled run. Run with `npm run reindex-search` (add `--env-file=.env` if
 * env vars aren't already exported in the shell).
 *
 * @returns {Promise<void>} Resolves once the reindex attempt completes.
 */
async function main() {
  await runSearchReindex();
  console.log("Done.");
}

main().catch((err) => {
  console.error("reindex-search failed:", err);
  process.exit(1);
});
