import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { ProcessingJobRun } from "../../lib/models/index.js";
import {
  buildParamsKey,
  findJobRun,
  markJobRunCancelled,
  markJobRunComplete,
  markJobRunFailed,
  markJobRunProcessing,
  upsertCompleteSubtitleLanguageRun,
  upsertPendingJobRun,
} from "../../lib/processing-job-runs.js";
import { resetTables, seedTranscodeProfile, seedUpload, setupSchema } from "../helpers/db.js";

describe("buildParamsKey", () => {
  test("keys rendition by transcodeProfileId", () => {
    expect(buildParamsKey("rendition", { transcodeProfileId: 7 })).toBe("profile:7");
  });

  test("keys subtitle by language, falling back to 'unknown'", () => {
    expect(buildParamsKey("subtitle", { language: "en" })).toBe("lang:en");
    expect(buildParamsKey("subtitle", {})).toBe("lang:unknown");
  });

  test("keys thumbnail by its requested timestamp, or 'random' when absent", () => {
    expect(buildParamsKey("thumbnail", { thumbnailTimestampTenths: 123 })).toBe("ts:123");
    expect(buildParamsKey("thumbnail", {})).toBe("ts:random");
  });

  test("keys embed by isDefaultThumbnail", () => {
    expect(buildParamsKey("embed", { isDefaultThumbnail: true })).toBe("default:true");
    expect(buildParamsKey("embed", { isDefaultThumbnail: false })).toBe("default:false");
  });

  test("keys every parameter-less kind as 'singleton'", () => {
    expect(buildParamsKey("hls")).toBe("singleton");
    expect(buildParamsKey("normalize")).toBe("singleton");
    expect(buildParamsKey("hash")).toBe("singleton");
  });
});

describe("processing-job-runs lifecycle", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("upsertPendingJobRun creates a row keyed by (upload, kind, paramsKey)", async () => {
    const upload = await seedUpload();
    const profile = await seedTranscodeProfile();

    const row = await upsertPendingJobRun({
      originalUploadId: upload.id,
      jobKind: "rendition",
      jobId: "job-1",
      transcodeProfileId: profile.id,
    });

    expect(row.status).toBe("pending");
    expect(row.paramsKey).toBe(`profile:${profile.id}`);
    expect(row.jobId).toBe("job-1");

    const rows = await ProcessingJobRun.findAll({ where: { originalUploadId: upload.id } });
    expect(rows).toHaveLength(1);
  });

  test("upsertPendingJobRun reuses the same row on a re-enqueue, overwriting jobId and clearing errorMessage", async () => {
    const upload = await seedUpload();

    const first = await upsertPendingJobRun({
      originalUploadId: upload.id,
      jobKind: "hash",
      jobId: "hash-A",
    });
    await markJobRunFailed(first.jobId, "boom");

    const second = await upsertPendingJobRun({
      originalUploadId: upload.id,
      jobKind: "hash",
      jobId: "hash-B",
    });

    expect(second.id).toBe(first.id);
    expect(second.jobId).toBe("hash-B");
    expect(second.status).toBe("pending");
    expect(second.errorMessage).toBeNull();

    const rows = await ProcessingJobRun.findAll({ where: { originalUploadId: upload.id } });
    expect(rows).toHaveLength(1);
  });

  test("markJobRunProcessing/Complete/Failed/Cancelled update by jobId", async () => {
    const upload = await seedUpload();
    await upsertPendingJobRun({ originalUploadId: upload.id, jobKind: "hls", jobId: "hls-1" });

    await markJobRunProcessing("hls-1");
    expect((await findJobRun(upload.id, "hls")).status).toBe("processing");

    await markJobRunComplete("hls-1");
    expect((await findJobRun(upload.id, "hls")).status).toBe("complete");

    await markJobRunFailed("hls-1", "ffmpeg exploded");
    let row = await findJobRun(upload.id, "hls");
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toBe("ffmpeg exploded");

    await markJobRunCancelled("hls-1");
    row = await findJobRun(upload.id, "hls");
    expect(row.status).toBe("cancelled");
  });

  test("a status update for a stale (superseded) jobId matches zero rows", async () => {
    const upload = await seedUpload();
    await upsertPendingJobRun({ originalUploadId: upload.id, jobKind: "thumbnail", jobId: "thumb-OLD" });
    // A fresh regeneration overwrites the row's jobId to "thumb-NEW".
    await upsertPendingJobRun({ originalUploadId: upload.id, jobKind: "thumbnail", jobId: "thumb-NEW" });

    // The old job's completion callback fires late, after being superseded.
    await markJobRunComplete("thumb-OLD");

    const row = await findJobRun(upload.id, "thumbnail");
    expect(row.jobId).toBe("thumb-NEW");
    expect(row.status).toBe("pending");
  });

  test("markJobRunFailed truncates an overlong error message to 255 chars", async () => {
    const upload = await seedUpload();
    await upsertPendingJobRun({ originalUploadId: upload.id, jobKind: "hash", jobId: "hash-1" });

    await markJobRunFailed("hash-1", "x".repeat(500));

    const row = await findJobRun(upload.id, "hash");
    expect(row.errorMessage).toHaveLength(255);
  });

  test("upsertCompleteSubtitleLanguageRun creates one complete row per language, independent of the enqueue-time singleton row", async () => {
    const upload = await seedUpload();
    await upsertPendingJobRun({ originalUploadId: upload.id, jobKind: "subtitle", jobId: "subtitle-1" });

    await upsertCompleteSubtitleLanguageRun({
      originalUploadId: upload.id,
      jobId: "subtitle-1",
      language: "en",
    });
    await upsertCompleteSubtitleLanguageRun({
      originalUploadId: upload.id,
      jobId: "subtitle-1",
      language: "fr",
    });

    const rows = await ProcessingJobRun.findAll({
      where: { originalUploadId: upload.id, jobKind: "subtitle" },
      order: [["paramsKey", "ASC"]],
    });
    expect(rows.map((r) => ({ paramsKey: r.paramsKey, status: r.status }))).toEqual([
      { paramsKey: "lang:en", status: "complete" },
      { paramsKey: "lang:fr", status: "complete" },
      { paramsKey: "lang:unknown", status: "pending" },
    ]);
  });

  test("findJobRun returns null when this exact job has never run", async () => {
    const upload = await seedUpload();

    expect(await findJobRun(upload.id, "rendition", { transcodeProfileId: 99 })).toBeNull();
  });

  test("findJobRun distinguishes different rendition profiles for the same upload", async () => {
    const upload = await seedUpload();
    const profileA = await seedTranscodeProfile();
    const profileB = await seedTranscodeProfile();
    await upsertPendingJobRun({
      originalUploadId: upload.id,
      jobKind: "rendition",
      jobId: "job-720p",
      transcodeProfileId: profileA.id,
    });

    expect(
      await findJobRun(upload.id, "rendition", { transcodeProfileId: profileA.id }),
    ).not.toBeNull();
    expect(
      await findJobRun(upload.id, "rendition", { transcodeProfileId: profileB.id }),
    ).toBeNull();
  });
});
