import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { ProcessingJobRun } from "../../lib/models/index.js";
import {
  backfillEmbedJobRuns,
  backfillHashJobRuns,
  backfillHlsJobRuns,
  backfillRenditionJobRuns,
  backfillSubtitleJobRuns,
  backfillThumbnailJobRuns,
  runProcessingJobRunsBackfill,
} from "../../scripts/backfill-processing-job-runs.js";
import {
  resetTables,
  seedFileVersion,
  seedTranscodeProfile,
  seedUpload,
  seedVideoSubtitle,
  seedVideoThumbnail,
  setupSchema,
} from "../helpers/db.js";

describe("backfill-processing-job-runs script", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  describe("backfillRenditionJobRuns", () => {
    test("creates one row per FILE_VERSIONS row, copying its status and profile", async () => {
      const upload = await seedUpload();
      const profile = await seedTranscodeProfile();
      const version = await seedFileVersion(upload.id, {
        status: "complete",
        transcodeProfileId: profile.id,
      });

      const count = await backfillRenditionJobRuns();

      expect(count).toBe(1);
      const row = await ProcessingJobRun.findOne({
        where: { originalUploadId: upload.id, jobKind: "rendition" },
      });
      expect(row.jobId).toBe(version.uuidName);
      expect(row.status).toBe("complete");
      expect(row.transcodeProfileId).toBe(profile.id);
      expect(row.paramsKey).toBe(`profile:${profile.id}`);
    });

    test("is idempotent - a second run creates nothing new", async () => {
      const upload = await seedUpload();
      await seedFileVersion(upload.id, { status: "complete" });

      expect(await backfillRenditionJobRuns()).toBe(1);
      expect(await backfillRenditionJobRuns()).toBe(0);
      expect(await ProcessingJobRun.count()).toBe(1);
    });

    test("never overwrites a row the live code already wrote", async () => {
      const upload = await seedUpload();
      const profile = await seedTranscodeProfile();
      const version = await seedFileVersion(upload.id, {
        status: "processing",
        transcodeProfileId: profile.id,
      });
      // Simulates the live upsert path already having recorded this job as
      // in-flight, with a status FILE_VERSIONS.status doesn't even have.
      await ProcessingJobRun.create({
        originalUploadId: upload.id,
        jobKind: "rendition",
        paramsKey: `profile:${profile.id}`,
        jobId: version.uuidName,
        status: "processing",
      });

      await backfillRenditionJobRuns();

      const row = await ProcessingJobRun.findOne({
        where: { originalUploadId: upload.id, jobKind: "rendition" },
      });
      expect(row.status).toBe("processing");
    });
  });

  describe("backfillSubtitleJobRuns", () => {
    test("creates a complete row per auto-extracted language, skipping user-provided ones", async () => {
      const upload = await seedUpload();
      await seedVideoSubtitle(upload.id, { source: "auto", label: "en" });
      await seedVideoSubtitle(upload.id, { source: "user", label: "fr" });

      const count = await backfillSubtitleJobRuns();

      expect(count).toBe(1);
      const rows = await ProcessingJobRun.findAll({
        where: { originalUploadId: upload.id, jobKind: "subtitle" },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("complete");
      expect(rows[0].paramsKey).toBe("lang:en");
    });
  });

  describe("backfillThumbnailJobRuns", () => {
    test("marks an upload with a VIDEO_THUMBNAIL row complete", async () => {
      const upload = await seedUpload({ status: "uploaded" });
      await seedVideoThumbnail(upload.id);

      await backfillThumbnailJobRuns();

      const row = await ProcessingJobRun.findOne({
        where: { originalUploadId: upload.id, jobKind: "thumbnail" },
      });
      expect(row.status).toBe("complete");
    });

    test("marks an upload with no VIDEO_THUMBNAIL row failed", async () => {
      const upload = await seedUpload({ status: "uploaded" });

      await backfillThumbnailJobRuns();

      const row = await ProcessingJobRun.findOne({
        where: { originalUploadId: upload.id, jobKind: "thumbnail" },
      });
      expect(row.status).toBe("failed");
    });

    test("skips an upload still downloading or converting", async () => {
      const upload = await seedUpload({ status: "downloading" });

      await backfillThumbnailJobRuns();

      const row = await ProcessingJobRun.findOne({
        where: { originalUploadId: upload.id, jobKind: "thumbnail" },
      });
      expect(row).toBeNull();
    });
  });

  describe("backfillHashJobRuns", () => {
    test("creates a complete row for an upload with a contentHash", async () => {
      const upload = await seedUpload({ contentHash: "sha256:abc" });

      const count = await backfillHashJobRuns();

      expect(count).toBe(1);
      const row = await ProcessingJobRun.findOne({
        where: { originalUploadId: upload.id, jobKind: "hash" },
      });
      expect(row.status).toBe("complete");
      expect(row.jobId).toBe(`hash-${upload.videoId}`);
    });

    test("skips an upload with no contentHash", async () => {
      await seedUpload({ contentHash: null });

      expect(await backfillHashJobRuns()).toBe(0);
    });
  });

  describe("backfillHlsJobRuns", () => {
    test("creates a complete row for an upload with hlsPlaylistStoragePath", async () => {
      const upload = await seedUpload({
        hlsPlaylistStoragePath: "transcoded/x.hls/variant.m3u8",
      });

      const count = await backfillHlsJobRuns();

      expect(count).toBe(1);
      const row = await ProcessingJobRun.findOne({
        where: { originalUploadId: upload.id, jobKind: "hls" },
      });
      expect(row.status).toBe("complete");
    });
  });

  describe("backfillEmbedJobRuns", () => {
    test("creates a complete row (carrying isDefaultThumbnail) for an upload with an embed video", async () => {
      const upload = await seedUpload({
        embedVideoStoragePath: "transcoded/x-embed.mp4",
        embedVideoIsDefault: true,
      });

      const count = await backfillEmbedJobRuns();

      expect(count).toBe(1);
      const row = await ProcessingJobRun.findOne({
        where: { originalUploadId: upload.id, jobKind: "embed" },
      });
      expect(row.status).toBe("complete");
      expect(row.isDefaultThumbnail).toBe(true);
      expect(row.paramsKey).toBe("default:true");
    });
  });

  describe("runProcessingJobRunsBackfill", () => {
    test("runs every backfill and reports counts per kind", async () => {
      const upload = await seedUpload({ contentHash: "sha256:abc" });
      await seedFileVersion(upload.id, { status: "complete" });

      const counts = await runProcessingJobRunsBackfill();

      expect(counts).toEqual({
        rendition: 1,
        subtitle: 0,
        thumbnail: 1,
        hash: 1,
        hls: 0,
        embed: 0,
      });
    });
  });
});
