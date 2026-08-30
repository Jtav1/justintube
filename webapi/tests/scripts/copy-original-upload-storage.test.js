import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { resolveMediaPath } from "../../lib/media-meta.js";
import { FileVersion, OriginalUpload, VideoThumbnail } from "../../lib/models/index.js";
import {
  resetTables,
  seedFileVersion,
  seedUpload,
  seedUser,
  seedVideoThumbnail,
  setupSchema,
} from "../helpers/db.js";
import {
  MANIFEST_PATH,
  migrateFileVersions,
  migrateOriginalUploads,
  migrateThumbnails,
  readManifest,
} from "../../scripts/copy-original-upload-storage.js";

/**
 * Writes a small fake media file at a `storagePath`-relative location,
 * creating parent directories as needed.
 *
 * @param {string} relativePath Path relative to `mediaDir` (e.g. "original/old.mp4").
 * @param {string} [contents] File contents.
 * @returns {Promise<string>} The absolute path written to.
 */
async function writeFakeMediaFile(relativePath, contents = "fake media bytes") {
  const absPath = resolveMediaPath(relativePath);
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, contents);
  return absPath;
}

describe("copy-original-upload-storage script", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
    // Each test starts with a clean manifest - the file persists on disk
    // across tests within a worker otherwise (it's designed to survive
    // process restarts in production), which would pollute later
    // assertions about manifest contents/counts.
    await rm(MANIFEST_PATH, { force: true });
  });

  describe("migrateOriginalUploads", () => {
    test("copies the file, backfills the row, and appends a manifest entry", async () => {
      const owner = await seedUser({ emailVerified: true });
      const upload = await seedUpload({
        userId: owner.id,
        fileExtension: "mp4",
        storagePath: "original/old-flat-name.mp4",
      });
      const oldAbsPath = await writeFakeMediaFile("original/old-flat-name.mp4");

      const result = await migrateOriginalUploads();

      expect(result.migrated).toBe(1);
      expect(result.failed).toBe(0);

      const reloaded = await OriginalUpload.findByPk(upload.id);
      const expectedNewPath = `original/${owner.id}/${reloaded.uuid}.mp4`;
      expect(reloaded.storagePath).toBe(expectedNewPath);
      // Old file untouched - the copy script never deletes anything.
      expect(existsSync(oldAbsPath)).toBe(true);
      expect(existsSync(resolveMediaPath(expectedNewPath))).toBe(true);

      const manifest = await readManifest();
      expect(manifest).toHaveLength(1);
      expect(manifest[0]).toMatchObject({
        table: "ORIGINAL_UPLOADS",
        id: upload.id,
      });
    });

    test("is idempotent on a second run - no re-copy, no duplicate manifest entry", async () => {
      const owner = await seedUser({ emailVerified: true });
      const upload = await seedUpload({
        userId: owner.id,
        fileExtension: "mp4",
        storagePath: "original/old-flat-name-2.mp4",
      });
      await writeFakeMediaFile("original/old-flat-name-2.mp4");

      await migrateOriginalUploads();
      const secondRun = await migrateOriginalUploads();

      expect(secondRun.migrated).toBe(0);
      expect(secondRun.skipped).toBe(1);

      const manifest = await readManifest();
      const entriesForUpload = manifest.filter((e) => e.table === "ORIGINAL_UPLOADS" && e.id === upload.id);
      expect(entriesForUpload).toHaveLength(1);
    });

    test("resumes cleanly when the new file already exists but the row wasn't updated yet", async () => {
      const owner = await seedUser({ emailVerified: true });
      const upload = await seedUpload({
        userId: owner.id,
        fileExtension: "mp4",
        storagePath: "original/old-flat-name-3.mp4",
      });
      // Simulate an interrupted prior run: the new file exists, but the row
      // still points at the old path.
      await writeFakeMediaFile(`original/${owner.id}/${upload.uuid}.mp4`);

      const result = await migrateOriginalUploads();

      expect(result.migrated).toBe(1);
      const reloaded = await OriginalUpload.findByPk(upload.id);
      expect(reloaded.storagePath).toBe(`original/${owner.id}/${upload.uuid}.mp4`);
    });

    test("logs an error and continues when the source file is missing", async () => {
      const owner = await seedUser({ emailVerified: true });
      const upload = await seedUpload({
        userId: owner.id,
        fileExtension: "mp4",
        storagePath: "original/never-written.mp4",
      });

      const result = await migrateOriginalUploads();

      expect(result.failed).toBe(1);
      const reloaded = await OriginalUpload.findByPk(upload.id);
      // Row left untouched - never partially updated on a failed copy.
      expect(reloaded.storagePath).toBe("original/never-written.mp4");
    });

    test("falls back to the _unowned subfolder for a null userId", async () => {
      const upload = await seedUpload({
        userId: null,
        fileExtension: "mp4",
        storagePath: "original/unowned-flat.mp4",
      });
      await writeFakeMediaFile("original/unowned-flat.mp4");

      await migrateOriginalUploads();

      const reloaded = await OriginalUpload.findByPk(upload.id);
      expect(reloaded.storagePath).toBe(`original/_unowned/${upload.uuid}.mp4`);
    });
  });

  describe("migrateFileVersions", () => {
    test("copies the rendition into the parent upload's userId subfolder", async () => {
      const owner = await seedUser({ emailVerified: true });
      const upload = await seedUpload({ userId: owner.id });
      const version = await seedFileVersion(upload.id, {
        storagePath: "transcoded/old-rendition.mp4",
      });
      await writeFakeMediaFile("transcoded/old-rendition.mp4");

      const result = await migrateFileVersions();

      expect(result.migrated).toBe(1);
      const reloaded = await FileVersion.findByPk(version.id);
      expect(reloaded.storagePath).toBe(`transcoded/${owner.id}/${version.uuidName}.mp4`);
      expect(existsSync(resolveMediaPath("transcoded/old-rendition.mp4"))).toBe(true);
    });
  });

  describe("migrateThumbnails", () => {
    test("copies the thumbnail into the parent upload's userId subfolder", async () => {
      const owner = await seedUser({ emailVerified: true });
      const upload = await seedUpload({ userId: owner.id });
      const thumbnail = await seedVideoThumbnail(upload.id, {
        thumbnailFilename: "old-thumb.jpg",
      });
      const oldAbsPath = resolveMediaPath("thumbnails/old-thumb.jpg");
      await mkdir(dirname(oldAbsPath), { recursive: true });
      await writeFile(oldAbsPath, "fake thumbnail bytes");

      const result = await migrateThumbnails();

      expect(result.migrated).toBe(1);
      const reloaded = await VideoThumbnail.findByPk(thumbnail.id);
      expect(reloaded.thumbnailFilename).toBe(`${owner.id}/old-thumb.jpg`);
    });

    test("skips a thumbnailFilename that already contains a subfolder", async () => {
      const owner = await seedUser({ emailVerified: true });
      const upload = await seedUpload({ userId: owner.id });
      await seedVideoThumbnail(upload.id, {
        thumbnailFilename: `${owner.id}/already-migrated.jpg`,
      });

      const result = await migrateThumbnails();

      expect(result.migrated).toBe(0);
      expect(result.skipped).toBe(1);
    });
  });

  describe("readManifest", () => {
    test("returns an empty array when no manifest file exists yet", async () => {
      expect(MANIFEST_PATH).toBeTruthy();
      const manifest = await readManifest();
      expect(manifest).toEqual([]);
    });
  });
});
