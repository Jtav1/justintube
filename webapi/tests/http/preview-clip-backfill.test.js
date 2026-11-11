import { afterEach, beforeAll, describe, expect, jest, test } from "@jest/globals";
import {
  resetTables,
  seedProcessingJobRun,
  seedUpload,
  setupSchema,
} from "../helpers/db.js";
import {
  enqueuePreviewBackfillJob,
  findUploadsMissingPreviewClip,
  getPreviewClipBackfillConfig,
  isPreviewBackfillEligible,
  runPreviewClipBackfill,
} from "../../lib/preview-clip-backfill.js";

/**
 * Unit tests for the nightly hover-preview clip backfill: finds uploads with
 * no preview clip yet and no in-flight job for one, and enqueues a packaging
 * job for each.
 */
describe("findUploadsMissingPreviewClip", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("finds an upload with no preview clip and a real stored file", async () => {
    const upload = await seedUpload();

    const results = await findUploadsMissingPreviewClip();

    expect(results.map((r) => r.videoId)).toContain(upload.videoId);
  });

  test("excludes an upload that already has a preview clip", async () => {
    await seedUpload({ previewClipStoragePath: "transcoded/u1/abc-preview.mp4" });

    const results = await findUploadsMissingPreviewClip();

    expect(results).toHaveLength(0);
  });

  test("excludes an upload with no stored file (never-finished import)", async () => {
    await seedUpload({ storagePath: "" });

    const results = await findUploadsMissingPreviewClip();

    expect(results).toHaveLength(0);
  });

  test("excludes an upload probed as definitely lacking a video stream", async () => {
    await seedUpload({ hasVideoStream: false });

    const results = await findUploadsMissingPreviewClip();

    expect(results).toHaveLength(0);
  });

  test("includes an upload whose hasVideoStream probe hasn't run yet (null)", async () => {
    const upload = await seedUpload({ hasVideoStream: null });

    const results = await findUploadsMissingPreviewClip();

    expect(results.map((r) => r.videoId)).toContain(upload.videoId);
  });
});

describe("isPreviewBackfillEligible", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("is eligible when no job run exists yet", async () => {
    const upload = await seedUpload();

    await expect(isPreviewBackfillEligible(upload.id)).resolves.toBe(true);
  });

  test("is not eligible when a job is pending", async () => {
    const upload = await seedUpload();
    await seedProcessingJobRun(upload.id, { jobKind: "preview", status: "pending" });

    await expect(isPreviewBackfillEligible(upload.id)).resolves.toBe(false);
  });

  test("is not eligible when a job is processing", async () => {
    const upload = await seedUpload();
    await seedProcessingJobRun(upload.id, { jobKind: "preview", status: "processing" });

    await expect(isPreviewBackfillEligible(upload.id)).resolves.toBe(false);
  });

  test("is eligible again after a job failed", async () => {
    const upload = await seedUpload();
    await seedProcessingJobRun(upload.id, { jobKind: "preview", status: "failed" });

    await expect(isPreviewBackfillEligible(upload.id)).resolves.toBe(true);
  });

  test("is eligible again after a job was cancelled", async () => {
    const upload = await seedUpload();
    await seedProcessingJobRun(upload.id, { jobKind: "preview", status: "cancelled" });

    await expect(isPreviewBackfillEligible(upload.id)).resolves.toBe(true);
  });
});

describe("enqueuePreviewBackfillJob", () => {
  /** @type {typeof fetch | undefined} */
  let originalFetch;

  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await resetTables();
  });

  test("enqueues a preview job against the processing service and records a pending job run", async () => {
    originalFetch = globalThis.fetch;
    const upload = await seedUpload({ storagePath: "original/_unowned/src.mp4" });

    globalThis.fetch = jest.fn(async (url, options) => {
      expect(String(url)).toContain("/transcode");
      const body = JSON.parse(String(options.body));
      expect(body.filename).toBe("_unowned/src.mp4");
      expect(body.jobs[0].kind).toBe("preview");
      return {
        ok: true,
        status: 202,
        json: async () => ({ success: true, jobs: [] }),
      };
    });

    const result = await enqueuePreviewBackfillJob(upload);

    expect(result).toEqual({ videoId: upload.videoId, action: "enqueued" });
  });

  test("reports failure without throwing when the processing call fails", async () => {
    originalFetch = globalThis.fetch;
    const upload = await seedUpload();

    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ success: false, error: "processing unreachable" }),
    }));

    const result = await enqueuePreviewBackfillJob(upload);

    expect(result.action).toBe("failed");
    expect(result.videoId).toBe(upload.videoId);
  });
});

describe("runPreviewClipBackfill", () => {
  /** @type {typeof fetch | undefined} */
  let originalFetch;

  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.ENABLE_TRANSCODING;
    await resetTables();
  });

  test("is a no-op and never contacts the processing service when transcoding is disabled", async () => {
    process.env.ENABLE_TRANSCODING = "false";
    originalFetch = globalThis.fetch;
    const unreachableFetch = jest.fn(() => {
      throw new Error("fetch should not be called when transcoding is disabled");
    });
    globalThis.fetch = unreachableFetch;

    await seedUpload();

    const result = await runPreviewClipBackfill();

    expect(result).toEqual({ total: 0, enqueued: 0, skipped: 0, failed: 0 });
    expect(unreachableFetch).not.toHaveBeenCalled();
  });

  test("enqueues for uploads missing a preview clip, skips ones already in flight", async () => {
    originalFetch = globalThis.fetch;
    const needsJob = await seedUpload();
    const inFlight = await seedUpload();
    await seedProcessingJobRun(inFlight.id, { jobKind: "preview", status: "pending" });
    await seedUpload({ previewClipStoragePath: "transcoded/u1/already-preview.mp4" });

    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 202,
      json: async () => ({ success: true, jobs: [] }),
    }));

    const result = await runPreviewClipBackfill();

    expect(result).toEqual({ total: 2, enqueued: 1, skipped: 1, failed: 0 });
    const postCalls = globalThis.fetch.mock.calls;
    expect(postCalls).toHaveLength(1);
    const body = JSON.parse(String(postCalls[0][1].body));
    expect(body.jobs[0].jobId).toContain(needsJob.videoId);
  });
});

describe("getPreviewClipBackfillConfig", () => {
  afterEach(() => {
    delete process.env.PREVIEW_CLIP_BACKFILL_ENABLED;
    delete process.env.PREVIEW_CLIP_BACKFILL_CRON;
  });

  test("defaults to enabled, nightly at 4am", () => {
    delete process.env.PREVIEW_CLIP_BACKFILL_ENABLED;
    delete process.env.PREVIEW_CLIP_BACKFILL_CRON;

    expect(getPreviewClipBackfillConfig()).toEqual({ cron: "0 4 * * *", enabled: true });
  });

  test("honors overrides", () => {
    process.env.PREVIEW_CLIP_BACKFILL_ENABLED = "false";
    process.env.PREVIEW_CLIP_BACKFILL_CRON = "*/10 * * * *";

    expect(getPreviewClipBackfillConfig()).toEqual({
      cron: "*/10 * * * *",
      enabled: false,
    });
  });
});
