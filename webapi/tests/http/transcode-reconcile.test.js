import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import {
  queryRows,
  resetTables,
  seedFileVersion,
  seedTranscodeProfile,
  seedUpload,
  setupSchema,
} from "../helpers/db.js";
import { reconcileFileVersion, runTranscodeReconcile } from "../../lib/transcode-reconcile.js";
import { FileVersion } from "../../lib/models/index.js";
import { logger } from "../../lib/logger.js";

/**
 * Unit tests for stale FILE_VERSIONS reconciliation against processing job state.
 */
describe("reconcileFileVersion", () => {
  /** @type {typeof fetch | undefined} */
  let originalFetch;

  beforeAll(async () => {
    await setupSchema();
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await resetTables();
  });

  test("heals a completed job into FILE_VERSIONS", async () => {
    const upload = await seedUpload({ status: "processing" });
    const version = await seedFileVersion(upload.id, {
      status: "processing",
      uuidName: "dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee",
      storagePath: "transcoded/dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee.mp4",
    });

    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        state: "completed",
        returnvalue: {
          fileSizeBytes: 999,
          videoWidth: 1280,
          videoHeight: 720,
          resolution: "720p",
          storagePath: version.storagePath,
          mimeType: "video/mp4",
        },
      }),
    }));

    const row = await FileVersion.findByPk(version.id);
    const result = await reconcileFileVersion(row);
    expect(result.action).toBe("healed_complete");

    const versions = await queryRows(
      "SELECT * FROM FILE_VERSIONS WHERE id = :id",
      { id: version.id },
    );
    expect(versions[0].status).toBe("complete");
    expect(Number(versions[0].file_size_bytes)).toBe(999);
  });

  test("marks failed jobs, removes them, and logs an error", async () => {
    const errorSpy = jest.spyOn(logger, "error").mockImplementation(() => {});
    const upload = await seedUpload({ status: "processing" });
    const version = await seedFileVersion(upload.id, {
      status: "processing",
      uuidName: "eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee",
    });

    globalThis.fetch = jest.fn(async (_url, options) => {
      if (options?.method === "DELETE") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, removed: true }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          state: "failed",
          failedReason: "ffmpeg died",
        }),
      };
    });

    const row = await FileVersion.findByPk(version.id);
    const result = await reconcileFileVersion(row);
    expect(result.action).toBe("marked_failed_removed");
    expect(errorSpy).toHaveBeenCalled();

    const versions = await queryRows(
      "SELECT * FROM FILE_VERSIONS WHERE id = :id",
      { id: version.id },
    );
    expect(versions[0].status).toBe("failed");

    const deleteCalls = globalThis.fetch.mock.calls.filter(
      ([, options]) => options?.method === "DELETE",
    );
    expect(deleteCalls).toHaveLength(1);

    errorSpy.mockRestore();
  });

  test("re-enqueues when the job is missing", async () => {
    const profile = await seedTranscodeProfile();
    const upload = await seedUpload({
      status: "processing",
      storagePath: "original/source.mp4",
    });
    const version = await seedFileVersion(upload.id, {
      status: "pending",
      uuidName: "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee",
      storagePath: "transcoded/ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee.mp4",
      transcodeProfileId: profile.id,
    });

    globalThis.fetch = jest.fn(async (_url, options) => {
      if (options?.method === "POST") {
        return {
          ok: true,
          status: 202,
          json: async () => ({ success: true, jobs: [] }),
        };
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({ success: false, error: "job not found" }),
      };
    });

    const row = await FileVersion.findByPk(version.id);
    const result = await reconcileFileVersion(row);
    expect(result.action).toBe("reenqueued");

    const versions = await queryRows(
      "SELECT * FROM FILE_VERSIONS WHERE id = :id",
      { id: version.id },
    );
    expect(versions[0].status).toBe("processing");

    const postCalls = globalThis.fetch.mock.calls.filter(
      ([, options]) => options?.method === "POST",
    );
    expect(postCalls).toHaveLength(1);
    const body = JSON.parse(String(postCalls[0][1].body));
    expect(body.filename).toBe("source.mp4");
    expect(body.jobs[0].jobId).toBe(version.uuidName);
  });
});

describe("runTranscodeReconcile with ENABLE_TRANSCODING=false", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    delete process.env.ENABLE_TRANSCODING;
    await resetTables();
  });

  test("is a no-op and never contacts the processing service", async () => {
    process.env.ENABLE_TRANSCODING = "false";
    const unreachableFetch = jest.fn(() => {
      throw new Error("fetch should not be called when transcoding is disabled");
    });
    globalThis.fetch = unreachableFetch;

    const upload = await seedUpload({ status: "processing" });
    await seedFileVersion(upload.id, {
      status: "pending",
      createdAt: new Date(Date.now() - 60 * 60_000),
    });

    const results = await runTranscodeReconcile();

    expect(results).toEqual([]);
    expect(unreachableFetch).not.toHaveBeenCalled();
  });
});
