import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { MANIFEST_PATH, readManifest } from "./copy-original-upload-storage.js";

/**
 * Rewrites the manifest file to contain only `remaining` entries - called
 * after successfully deleting some entries' old files, so a partial/
 * interrupted cleanup run doesn't re-attempt (or error on) already-deleted
 * files the next time it's invoked.
 *
 * @param {Array<{ table: string, id: number, oldAbsolutePath: string, newAbsolutePath: string }>} remaining
 * @returns {Promise<void>} Resolves once the manifest has been rewritten.
 */
async function rewriteManifest(remaining) {
  const contents = remaining.map((entry) => JSON.stringify(entry)).join("\n");
  await writeFile(MANIFEST_PATH, contents.length > 0 ? `${contents}\n` : "");
}

/**
 * Deletes every old file recorded in the copy-phase manifest
 * (`copy-original-upload-storage.js`), after re-verifying the corresponding
 * new file still exists at its recorded location - defense against
 * something having gone wrong between the two script runs. Never trusts a
 * reconstructed path; only ever acts on what the copy phase actually
 * recorded as successfully copied.
 *
 * @param {{ dryRun?: boolean }} [options] `dryRun: true` only reports what
 *   *would* be deleted, without deleting anything or touching the manifest.
 *   Defaults to actually deleting, matching `copy-original-upload-storage.js`'s
 *   default-does-the-real-thing behavior.
 * @returns {Promise<{ deleted: number, skipped: number, failed: number }>} Run summary.
 */
export async function cleanupOriginalUploadStorage({ dryRun = false } = {}) {
  const manifest = await readManifest();
  if (manifest.length === 0) {
    console.log("Manifest is empty - nothing to clean up.");
    return { deleted: 0, skipped: 0, failed: 0 };
  }

  let deleted = 0;
  let skipped = 0;
  let failed = 0;
  const remaining = [];

  for (const entry of manifest) {
    const { table, id, oldAbsolutePath, newAbsolutePath } = entry;

    if (!existsSync(newAbsolutePath)) {
      console.error(
        `[error] ${table} ${id}: new file missing at ${newAbsolutePath} - refusing to delete ${oldAbsolutePath}`,
      );
      failed++;
      remaining.push(entry);
      continue;
    }

    if (!existsSync(oldAbsolutePath)) {
      // Already deleted by a prior cleanup run - nothing left to do for this entry.
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`[dry-run] would delete ${oldAbsolutePath} (${table} ${id})`);
      remaining.push(entry);
      continue;
    }

    try {
      await unlink(oldAbsolutePath);
      console.log(`[deleted] ${table} ${id}: ${oldAbsolutePath}`);
      deleted++;
    } catch (err) {
      console.error(`[error] ${table} ${id}: failed to delete ${oldAbsolutePath}:`, err);
      failed++;
      remaining.push(entry);
    }
  }

  if (!dryRun) {
    // Only rewrite when entries were actually removed - a dry run leaves the
    // manifest untouched entirely.
    await rewriteManifest(remaining);
  }

  console.log(
    dryRun
      ? `Dry run complete: ${manifest.length - failed} file(s) would be deleted, ${failed} failed pre-check. Re-run without --dry-run to actually delete.`
      : `Cleanup complete: deleted=${deleted} skipped=${skipped} failed=${failed}`,
  );

  return { deleted, skipped, failed };
}

/**
 * Parses `process.argv` for `--dry-run`. Without it, this actually deletes
 * every manifested old file (matching `copy-original-upload-storage.js`'s
 * default-does-the-real-thing behavior) - pass `--dry-run` first to preview
 * what would be removed. Run with `npm run cleanup-old-upload-storage --
 * --dry-run` to preview, then `npm run cleanup-old-upload-storage` to
 * actually delete (inside the `justintube-api` container in production:
 * `docker compose exec webapi npm run cleanup-old-upload-storage`).
 *
 * @returns {Promise<void>} Resolves once the run completes.
 */
async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  console.log(
    dryRun
      ? "Starting storage-layout migration (cleanup phase, dry run) ..."
      : "Starting storage-layout migration (cleanup phase) ...",
  );
  await cleanupOriginalUploadStorage({ dryRun });
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error("cleanup-original-upload-storage failed:", err);
    process.exit(1);
  });
}
