import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { resolveMediaPath } from "../../lib/media-meta.js";
import { OriginalUpload } from "../../lib/models/index.js";
import { resetTables, seedUpload, seedUser, setupSchema } from "../helpers/db.js";
import {
  MANIFEST_PATH,
  migrateOriginalUploads,
  readManifest,
} from "../../scripts/copy-original-upload-storage.js";
import { cleanupOriginalUploadStorage } from "../../scripts/cleanup-original-upload-storage.js";

/**
 * Writes a small fake media file at a `storagePath`-relative location,
 * creating parent directories as needed.
 *
 * @param {string} relativePath Path relative to `mediaDir`.
 * @returns {Promise<string>} The absolute path written to.
 */
async function writeFakeMediaFile(relativePath) {
  const absPath = resolveMediaPath(relativePath);
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, "fake media bytes");
  return absPath;
}

/**
 * Runs the copy script for a single seeded upload, producing exactly one
 * manifest entry to exercise the cleanup script against.
 *
 * @returns {Promise<{ uploadId: number, oldAbsPath: string, newAbsPath: string }>}
 */
async function seedAndCopyOneUpload() {
  const owner = await seedUser({ emailVerified: true });
  const upload = await seedUpload({
    userId: owner.id,
    fileExtension: "mp4",
    storagePath: "original/old-flat.mp4",
  });
  const oldAbsPath = await writeFakeMediaFile("original/old-flat.mp4");
  await migrateOriginalUploads();
  const reloaded = await OriginalUpload.findByPk(upload.id);
  const newAbsPath = resolveMediaPath(reloaded.storagePath);
  return { uploadId: upload.id, oldAbsPath, newAbsPath };
}

describe("cleanup-original-upload-storage script", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
    await rm(MANIFEST_PATH, { force: true });
  });

  test("--dry-run deletes nothing and leaves the manifest untouched", async () => {
    const { oldAbsPath, newAbsPath } = await seedAndCopyOneUpload();

    const result = await cleanupOriginalUploadStorage({ confirm: false });

    expect(result.deleted).toBe(0);
    expect(existsSync(oldAbsPath)).toBe(true);
    expect(existsSync(newAbsPath)).toBe(true);
    const manifest = await readManifest();
    expect(manifest).toHaveLength(1);
  });

  test("--confirm deletes the old file, leaves the new file, and empties the manifest", async () => {
    const { oldAbsPath, newAbsPath } = await seedAndCopyOneUpload();

    const result = await cleanupOriginalUploadStorage({ confirm: true });

    expect(result.deleted).toBe(1);
    expect(existsSync(oldAbsPath)).toBe(false);
    expect(existsSync(newAbsPath)).toBe(true);
    const manifest = await readManifest();
    expect(manifest).toHaveLength(0);
  });

  test("re-running --confirm after entries are already cleaned up is a safe no-op", async () => {
    await seedAndCopyOneUpload();
    await cleanupOriginalUploadStorage({ confirm: true });

    const secondRun = await cleanupOriginalUploadStorage({ confirm: true });

    expect(secondRun.deleted).toBe(0);
    expect(secondRun.failed).toBe(0);
  });

  test("refuses to delete when the new file is unexpectedly missing", async () => {
    const { oldAbsPath, newAbsPath } = await seedAndCopyOneUpload();
    // Simulate something having gone wrong between the two script runs.
    await rm(newAbsPath, { force: true });

    const result = await cleanupOriginalUploadStorage({ confirm: true });

    expect(result.failed).toBe(1);
    expect(result.deleted).toBe(0);
    // Old file is preserved rather than orphaning the only remaining copy.
    expect(existsSync(oldAbsPath)).toBe(true);
    // The unresolved entry stays in the manifest for a future run to retry.
    const manifest = await readManifest();
    expect(manifest).toHaveLength(1);
  });

  test("reports nothing to clean up when the manifest is empty", async () => {
    const result = await cleanupOriginalUploadStorage({ confirm: true });
    expect(result).toEqual({ deleted: 0, skipped: 0, failed: 0 });
  });
});
