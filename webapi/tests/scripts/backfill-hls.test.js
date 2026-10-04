import { afterEach, beforeAll, describe, expect, jest, test } from "@jest/globals";
import { OriginalUpload } from "../../lib/models/index.js";
import { resetTables, seedUpload, setupSchema } from "../helpers/db.js";
import { enqueueHlsBackfillJob, findUploadsMissingHls, runHlsBackfill } from "../../scripts/backfill-hls.js";

describe("backfill-hls script", () => {
  /** @type {typeof fetch | undefined} */
  let originalFetch;

  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await resetTables();
  });

  describe("findUploadsMissingHls", () => {
    test("includes an upload whose width reaches 1080 but whose height doesn't", async () => {
      const upload = await seedUpload({ videoWidth: 1080, videoHeight: 600 });

      const rows = await findUploadsMissingHls();

      expect(rows.map((r) => r.id)).toEqual([upload.id]);
    });

    test("includes an upload whose height reaches 1080 but whose width doesn't", async () => {
      const upload = await seedUpload({ videoWidth: 600, videoHeight: 1080 });

      const rows = await findUploadsMissingHls();

      expect(rows.map((r) => r.id)).toEqual([upload.id]);
    });

    test("excludes an upload below 1080 on both axes", async () => {
      await seedUpload({ videoWidth: 854, videoHeight: 480 });

      const rows = await findUploadsMissingHls();

      expect(rows).toHaveLength(0);
    });

    test("excludes an upload that already has an hls stream", async () => {
      await seedUpload({
        videoWidth: 1920,
        videoHeight: 1080,
        hlsPlaylistStoragePath: "transcoded/already-done.hls/variant.m3u8",
      });

      const rows = await findUploadsMissingHls();

      expect(rows).toHaveLength(0);
    });

    test("excludes an upload still downloading (no storagePath yet)", async () => {
      await seedUpload({
        videoWidth: 1920,
        videoHeight: 1080,
        status: "downloading",
        storagePath: "",
        originalFilename: "",
        fileExtension: "",
      });

      const rows = await findUploadsMissingHls();

      expect(rows).toHaveLength(0);
    });

    test("is idempotent: a second run finds nothing once the first run's upload is marked complete", async () => {
      const upload = await seedUpload({ videoWidth: 1920, videoHeight: 1080 });

      expect(await findUploadsMissingHls()).toHaveLength(1);

      await OriginalUpload.update(
        { hlsPlaylistStoragePath: "transcoded/whatever.hls/variant.m3u8" },
        { where: { id: upload.id } },
      );

      expect(await findUploadsMissingHls()).toHaveLength(0);
    });
  });

  describe("enqueueHlsBackfillJob", () => {
    test("posts a batch request for the upload's hls job", async () => {
      const upload = await seedUpload({ videoWidth: 1920, videoHeight: 1080 });
      const fetchMock = jest.fn(async (_url, options) => ({
        ok: true,
        status: 202,
        json: async () => ({ success: true, jobs: [JSON.parse(String(options.body)).jobs[0]] }),
      }));
      globalThis.fetch = fetchMock;

      const result = await enqueueHlsBackfillJob(upload);

      expect(result).toEqual({ videoId: upload.videoId, action: "enqueued" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe("http://processing.test:3001/transcode");
      const payload = JSON.parse(String(fetchMock.mock.calls[0][1].body));
      expect(payload.jobs).toHaveLength(1);
      expect(payload.jobs[0].kind).toBe("hls");
      expect(payload.jobs[0].jobId).toMatch(new RegExp(`^hls-${upload.videoId}-`));
    });

    test("reports a failure outcome without throwing when processing is unreachable", async () => {
      const upload = await seedUpload({ videoWidth: 1920, videoHeight: 1080 });
      globalThis.fetch = jest.fn(async () => {
        throw new Error("network down");
      });

      const result = await enqueueHlsBackfillJob(upload);

      expect(result).toEqual({
        videoId: upload.videoId,
        action: "failed",
        error: "network down",
      });
    });
  });

  describe("runHlsBackfill", () => {
    test("enqueues every eligible upload and isolates one failure from the rest", async () => {
      const eligibleA = await seedUpload({ videoWidth: 1920, videoHeight: 1080 });
      const eligibleB = await seedUpload({ videoWidth: 1080, videoHeight: 1920 });
      await seedUpload({ videoWidth: 640, videoHeight: 480 }); // ineligible, left out entirely

      let call = 0;
      globalThis.fetch = jest.fn(async (_url, options) => {
        call++;
        if (call === 2) {
          throw new Error("network down");
        }
        return {
          ok: true,
          status: 202,
          json: async () => ({ success: true, jobs: [JSON.parse(String(options.body)).jobs[0]] }),
        };
      });

      const summary = await runHlsBackfill();

      expect(summary).toEqual({ total: 2, enqueued: 1, failed: 1 });
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      const requestedVideoIds = globalThis.fetch.mock.calls.map(
        (call_) => JSON.parse(String(call_[1].body)).jobs[0].jobId,
      );
      expect(requestedVideoIds.some((id) => id.startsWith(`hls-${eligibleA.videoId}-`))).toBe(true);
      expect(requestedVideoIds.some((id) => id.startsWith(`hls-${eligibleB.videoId}-`))).toBe(true);
    });

    test("is a no-op when nothing is eligible", async () => {
      globalThis.fetch = jest.fn();

      const summary = await runHlsBackfill();

      expect(summary).toEqual({ total: 0, enqueued: 0, failed: 0 });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });
});
