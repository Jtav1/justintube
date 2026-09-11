import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FileVersion, OriginalUpload, VideoThumbnail } from "../lib/models/index.js";
import { mediaDir, resolveMediaPath, userStorageSegment } from "../lib/media-meta.js";

/**
 * Directory the resumable manifest lives under. Overridable via
 * `STORAGE_MIGRATION_STATE_DIR` (used by tests to isolate parallel Jest
 * workers from each other and from the real `scripts/state/` directory);
 * defaults to `scripts/state/` alongside this file in production.
 *
 * @type {string}
 */
const STATE_DIR =
  process.env.STORAGE_MIGRATION_STATE_DIR ||
  join(dirname(fileURLToPath(import.meta.url)), "state");

/**
 * Absolute path to the resumable manifest this script appends to on every
 * successful copy - the source of truth `cleanup-original-upload-storage.js`
 * reads from to know which old files are safe to delete. Never guesses at
 * old paths independently.
 *
 * @type {string}
 */
export const MANIFEST_PATH = join(STATE_DIR, "storage-migration-manifest.jsonl");

/**
 * Appends one manifest entry (as a JSON line) recording a successfully
 * copy-verified old/new file pair.
 *
 * @param {{ table: string, id: number, oldAbsolutePath: string, newAbsolutePath: string }} entry
 * @returns {Promise<void>} Resolves once the line has been appended.
 */
async function appendManifestEntry(entry) {
  await mkdir(dirname(MANIFEST_PATH), { recursive: true });
  await writeFile(MANIFEST_PATH, `${JSON.stringify(entry)}\n`, { flag: "a" });
}

/**
 * Migrates every `ORIGINAL_UPLOADS` row: backfills `uuid` (if not already
 * set) and copies the source file from its old flat/legacy location to
 * `original/<userId|_unowned>/<uuid>.<ext>`, updating `storagePath` to
 * match. The old file is left in place untouched - only
 * `cleanup-original-upload-storage.js` removes it, and only after the admin
 * has verified the new layout.
 *
 * @param {{ dryRun?: boolean }} [options] `dryRun: true` reports what would
 *   happen (paths, existence checks) without copying any file, writing any
 *   row, or touching the manifest.
 * @returns {Promise<{ migrated: number, skipped: number, failed: number }>} Run summary.
 */
export async function migrateOriginalUploads({ dryRun = false } = {}) {
  const rows = await OriginalUpload.findAll();
  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  const prefix = dryRun ? "[dry-run] " : "";

  for (const upload of rows) {
    try {
      if (!upload.storagePath || !upload.fileExtension) {
        // Stuck "downloading" import placeholder (download never completed) -
        // nothing on disk to move.
        console.log(`[skip] ORIGINAL_UPLOADS ${upload.id}: no storagePath/fileExtension yet`);
        skipped++;
        continue;
      }

      const uuid = upload.uuid || randomUUID();
      const segment = userStorageSegment(upload.userId);
      const newStoragePath = `original/${segment}/${uuid}.${upload.fileExtension}`;

      if (upload.storagePath === newStoragePath && upload.uuid) {
        // Already fully migrated by a prior run.
        skipped++;
        continue;
      }

      const oldAbsPath = resolveMediaPath(upload.storagePath);
      const newAbsPath = resolveMediaPath(newStoragePath);

      if (existsSync(newAbsPath)) {
        // File already copied (interrupted prior run) - just fix up the row.
        console.log(
          `${prefix}[db-only] ORIGINAL_UPLOADS ${upload.id}: already at ${newStoragePath}`,
        );
        if (!dryRun) {
          await upload.update({ uuid, storagePath: newStoragePath });
          await appendManifestEntry({
            table: "ORIGINAL_UPLOADS",
            id: upload.id,
            oldAbsolutePath: oldAbsPath,
            newAbsolutePath: newAbsPath,
          });
        }
        migrated++;
        continue;
      }

      if (!existsSync(oldAbsPath)) {
        console.error(
          `[error] ORIGINAL_UPLOADS ${upload.id}: source file missing at ${upload.storagePath}`,
        );
        failed++;
        continue;
      }

      console.log(
        `${prefix}[ok] ORIGINAL_UPLOADS ${upload.id}: ${upload.storagePath} -> ${newStoragePath}`,
      );
      if (!dryRun) {
        await mkdir(dirname(newAbsPath), { recursive: true });
        await copyFile(oldAbsPath, newAbsPath);
        await upload.update({ uuid, storagePath: newStoragePath });
        await appendManifestEntry({
          table: "ORIGINAL_UPLOADS",
          id: upload.id,
          oldAbsolutePath: oldAbsPath,
          newAbsolutePath: newAbsPath,
        });
      }
      migrated++;
    } catch (err) {
      console.error(`[error] ORIGINAL_UPLOADS ${upload.id} failed:`, err);
      failed++;
    }
  }

  console.log(
    `${prefix}ORIGINAL_UPLOADS: migrated=${migrated} skipped=${skipped} failed=${failed}`,
  );
  return { migrated, skipped, failed };
}

/**
 * Migrates every `FILE_VERSIONS` row: copies the rendition file from its old
 * flat location to `transcoded/<userId|_unowned>/<uuidName>.<ext>` (keyed by
 * the *parent* upload's userId) and updates `storagePath`. No new column -
 * renditions already have UUID filenames, only the folder changes.
 *
 * @param {{ dryRun?: boolean }} [options] `dryRun: true` reports what would
 *   happen without copying any file, writing any row, or touching the manifest.
 * @returns {Promise<{ migrated: number, skipped: number, failed: number }>} Run summary.
 */
export async function migrateFileVersions({ dryRun = false } = {}) {
  const versions = await FileVersion.findAll();
  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  const prefix = dryRun ? "[dry-run] " : "";

  for (const version of versions) {
    try {
      const parent = await OriginalUpload.findByPk(version.originalUploadId, {
        attributes: ["userId"],
      });
      const segment = userStorageSegment(parent?.userId ?? null);
      const newStoragePath = `transcoded/${segment}/${version.uuidName}.${version.fileExtension}`;

      if (version.storagePath === newStoragePath) {
        skipped++;
        continue;
      }

      const oldAbsPath = resolveMediaPath(version.storagePath);
      const newAbsPath = resolveMediaPath(newStoragePath);

      if (existsSync(newAbsPath)) {
        console.log(
          `${prefix}[db-only] FILE_VERSIONS ${version.id}: already at ${newStoragePath}`,
        );
        if (!dryRun) {
          await version.update({ storagePath: newStoragePath });
          await appendManifestEntry({
            table: "FILE_VERSIONS",
            id: version.id,
            oldAbsolutePath: oldAbsPath,
            newAbsolutePath: newAbsPath,
          });
        }
        migrated++;
        continue;
      }

      if (!existsSync(oldAbsPath)) {
        // Pending/failed render - nothing to copy, but the path still needs
        // to point at where the file will eventually land.
        console.warn(
          `${prefix}[skip] FILE_VERSIONS ${version.id}: source missing at ${version.storagePath} (pending/failed?)`,
        );
        if (!dryRun) {
          await version.update({ storagePath: newStoragePath });
        }
        skipped++;
        continue;
      }

      console.log(
        `${prefix}[ok] FILE_VERSIONS ${version.id}: ${version.storagePath} -> ${newStoragePath}`,
      );
      if (!dryRun) {
        await mkdir(dirname(newAbsPath), { recursive: true });
        await copyFile(oldAbsPath, newAbsPath);
        await version.update({ storagePath: newStoragePath });
        await appendManifestEntry({
          table: "FILE_VERSIONS",
          id: version.id,
          oldAbsolutePath: oldAbsPath,
          newAbsolutePath: newAbsPath,
        });
      }
      migrated++;
    } catch (err) {
      console.error(`[error] FILE_VERSIONS ${version.id} failed:`, err);
      failed++;
    }
  }

  console.log(`${prefix}FILE_VERSIONS: migrated=${migrated} skipped=${skipped} failed=${failed}`);
  return { migrated, skipped, failed };
}

/**
 * Matches a UUID basename in the 8-4-4-4-12 hex-group shape `randomUUID()`
 * produces (optionally followed by an extension) - used to recognize a
 * thumbnail this migration has already renamed on a prior run, or a
 * manually-uploaded thumbnail, which is already UUID-named at upload time
 * (see the thumbnail-upload multer `filename` callback in routes/videos.js).
 *
 * @type {RegExp}
 */
const UUID_BASENAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[^/]+)?$/i;

/**
 * Whether `thumbnailFilename` is already in the fully-migrated shape: nested
 * under exactly one `<userId|_unowned>/` subfolder segment, with a
 * UUID-shaped basename. True for both "already migrated by this script" and
 * "was always UUID-named" cases - either way, nothing left to do.
 *
 * @param {string} thumbnailFilename Current `VIDEO_THUMBNAIL.thumbnailFilename` value.
 * @returns {boolean} True when the filename needs no further change.
 */
function isFullyMigratedThumbnailFilename(thumbnailFilename) {
  const parts = thumbnailFilename.split("/");
  return parts.length === 2 && UUID_BASENAME_PATTERN.test(parts[1]);
}

/**
 * Migrates every `VIDEO_THUMBNAIL` row: copies the thumbnail image from its
 * old location to `thumbnails/<userId|_unowned>/<uuid>.<ext>` (keyed by the
 * *parent* upload's userId) and updates `thumbnailFilename` to match -
 * renaming the basename to a fresh UUID, same as `migrateOriginalUploads`
 * does for `ORIGINAL_UPLOADS`, rather than just relocating it into a
 * subfolder under its old name. Auto-generated thumbnails previously kept
 * their videoId-based basename after migration; this brings them in line
 * with every other migrated file. No new column is needed - unlike
 * `ORIGINAL_UPLOADS.uuid`, nothing else references a thumbnail's UUID
 * independently of `thumbnailFilename` itself, so the new name only ever
 * needs to be written to that one column.
 *
 * @param {{ dryRun?: boolean }} [options] `dryRun: true` reports what would
 *   happen without copying any file, writing any row, or touching the manifest.
 * @returns {Promise<{ migrated: number, skipped: number, failed: number }>} Run summary.
 */
export async function migrateThumbnails({ dryRun = false } = {}) {
  const thumbnails = await VideoThumbnail.findAll();
  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  const prefix = dryRun ? "[dry-run] " : "";

  for (const thumbnail of thumbnails) {
    try {
      const oldFilename = thumbnail.thumbnailFilename;
      if (isFullyMigratedThumbnailFilename(oldFilename)) {
        // Already migrated by a prior run, or always UUID-named.
        skipped++;
        continue;
      }

      const parent = await OriginalUpload.findByPk(thumbnail.originalUploadId, {
        attributes: ["userId"],
      });
      const segment = userStorageSegment(parent?.userId ?? null);
      const ext = extname(oldFilename).replace(/^\./, "");
      const newFilename = `${segment}/${randomUUID()}${ext ? `.${ext}` : ""}`;
      const oldAbsPath = join(mediaDir, "thumbnails", oldFilename);
      const newAbsPath = join(mediaDir, "thumbnails", newFilename);

      if (!existsSync(oldAbsPath)) {
        console.warn(
          `[skip] VIDEO_THUMBNAIL ${thumbnail.id}: source missing at ${oldFilename}`,
        );
        skipped++;
        continue;
      }

      console.log(
        `${prefix}[ok] VIDEO_THUMBNAIL ${thumbnail.id}: ${oldFilename} -> ${newFilename}`,
      );
      if (!dryRun) {
        await mkdir(dirname(newAbsPath), { recursive: true });
        await copyFile(oldAbsPath, newAbsPath);
        await thumbnail.update({ thumbnailFilename: newFilename });
        await appendManifestEntry({
          table: "VIDEO_THUMBNAIL",
          id: thumbnail.id,
          oldAbsolutePath: oldAbsPath,
          newAbsolutePath: newAbsPath,
        });
      }
      migrated++;
    } catch (err) {
      console.error(`[error] VIDEO_THUMBNAIL ${thumbnail.id} failed:`, err);
      failed++;
    }
  }

  console.log(
    `${prefix}VIDEO_THUMBNAIL: migrated=${migrated} skipped=${skipped} failed=${failed}`,
  );
  return { migrated, skipped, failed };
}

/**
 * Reads the current manifest file, if any (used by tests / callers that want
 * to inspect what's been recorded so far without re-running a migration).
 *
 * @returns {Promise<Array<{ table: string, id: number, oldAbsolutePath: string, newAbsolutePath: string }>>}
 */
export async function readManifest() {
  try {
    const raw = await readFile(MANIFEST_PATH, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (err) {
    if (err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

/**
 * Copies every original upload, rendition, and thumbnail file into its new
 * per-user-subfolder location and backfills `ORIGINAL_UPLOADS.uuid`,
 * updating each row's storage path/filename to match. Never deletes
 * anything - old files are left in place so an admin can verify the new
 * layout before running `cleanup-original-upload-storage.js` to reclaim the
 * disk space. Safe to re-run: every row is checked against its expected
 * final state before any work is done, so an interrupted run can simply be
 * re-invoked. Pass `--dry-run` to preview what would be copied/updated
 * without writing anything. Run with `npm run migrate-upload-storage`
 * (inside the `justintube-api` container in production: `docker compose exec
 * webapi npm run migrate-upload-storage -- --dry-run`, then again without
 * `--dry-run` to actually copy).
 *
 * @returns {Promise<void>} Resolves once all three tables have been processed.
 */
async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  console.log(
    dryRun
      ? "Starting storage-layout migration (copy phase, dry run) ..."
      : "Starting storage-layout migration (copy phase) ...",
  );
  await migrateOriginalUploads({ dryRun });
  await migrateFileVersions({ dryRun });
  await migrateThumbnails({ dryRun });
  if (dryRun) {
    console.log("Dry run complete. Nothing was written. Re-run without --dry-run to apply.");
  } else {
    console.log(`Done. Manifest: ${MANIFEST_PATH}`);
    console.log(
      "Old files were left in place. Once you've verified the new layout, run " +
        "`npm run cleanup-old-upload-storage -- --dry-run` to preview, then " +
        "`npm run cleanup-old-upload-storage` to actually delete them.",
    );
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error("copy-original-upload-storage failed:", err);
    process.exit(1);
  });
}
