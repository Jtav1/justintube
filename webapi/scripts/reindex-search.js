import { OriginalUpload, VideoMetadata } from "../lib/models/index.js";
import { searchEnabled, syncVideoIndex } from "../lib/search.js";

/**
 * Bulk-(re)indexes every eligible (ready + public) video into Meilisearch.
 * Used for initial rollout (the index starts empty) and disaster recovery
 * (rebuilding after the Meilisearch volume is wiped). Run with
 * `npm run reindex-search` (add `--env-file=.env` if env vars aren't already
 * exported in the shell).
 *
 * @returns {Promise<void>} Resolves once every eligible video has been synced.
 */
async function main() {
  if (!searchEnabled()) {
    console.error(
      "ENABLE_ADVANCED_SEARCH is not set to true; nothing to do.",
    );
    process.exit(1);
  }

  const uploads = await OriginalUpload.findAll({
    where: { status: "ready" },
    include: [
      {
        model: VideoMetadata,
        as: "VideoMetadata",
        required: true,
        where: { visibility: "public" },
      },
    ],
    attributes: ["id"],
  });

  console.log(`Reindexing ${uploads.length} eligible video(s)...`);
  for (const upload of uploads) {
    await syncVideoIndex(upload.id);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error("reindex-search failed:", err);
  process.exit(1);
});
