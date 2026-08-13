import { Buffer } from "node:buffer";
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import { resetTables, seedUser, seedUserApiKey, setupSchema } from "../helpers/db.js";

/**
 * Waits for pending microtasks/timers to flush, so fire-and-forget calls
 * kicked off during the request (but not awaited by the handler) have had a
 * chance to run before assertions inspect them.
 *
 * @returns {Promise<void>} Resolves after a macrotask tick.
 */
function flushBackgroundWork() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * HTTP contract tests for the `ENABLE_DUPLICATE_UPLOAD_DETECTION` gate in
 * `routes/uploads.js` (`enqueueDuplicateHashCheck`). Verifies: disabled by
 * default (no hash job enqueued); when enabled, a hash job is enqueued in
 * the background *in addition to* the normal transcode batch, without
 * delaying or altering the upload response in any way; and a failed
 * hash-job enqueue call is swallowed, never affecting the upload.
 */
describe("ENABLE_DUPLICATE_UPLOAD_DETECTION gate", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;
  /** @type {typeof fetch | undefined} */
  let originalFetch;
  /** @type {{id: number} & Record<string, unknown>} */
  let uploaderUser;
  const uploaderKey = "jt_test_dup_detection_key";

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.ENABLE_DUPLICATE_UPLOAD_DETECTION;
    await resetTables();
  });

  /**
   * Seeds an uploader-flagged user with an API key.
   *
   * @returns {Promise<void>} Resolves once the uploader user + key exist.
   */
  async function seedUploaderCreds() {
    uploaderUser = await seedUser({ uploader: true, emailVerified: true });
    await seedUserApiKey(uploaderUser.id, uploaderKey);
  }

  test("defaults to off: an upload finalizes normally and never enqueues a hash job", async () => {
    const fetchMock = jest.fn(async (_url, options) => {
      const body = JSON.parse(String(options.body));
      expect(body.jobs.some((job) => job.kind === "hash")).toBe(false);
      return {
        ok: true,
        status: 202,
        json: async () => ({
          success: true,
          jobs: body.jobs.map((job) => ({
            jobId: job.jobId,
            outputFilename: job.outputFilename,
            profileId: job.profile?.id ?? null,
          })),
        }),
      };
    });
    globalThis.fetch = fetchMock;

    await seedUploaderCreds();
    const res = await client
      .post("/api/v1/videos/upload")
      .set("Authorization", `Bearer ${uploaderKey}`)
      .attach("file", Buffer.from("tiny"), "clip.mp4");

    expect(res.status).toBe(201);
    expect(res.body.status).not.toBe("hashing");
    await flushBackgroundWork();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("when enabled, finalizes the upload exactly as before and enqueues an extra hash job in the background", async () => {
    process.env.ENABLE_DUPLICATE_UPLOAD_DETECTION = "true";
    const calls = [];
    const fetchMock = jest.fn(async (_url, options) => {
      const body = JSON.parse(String(options.body));
      calls.push(body);
      return {
        ok: true,
        status: 202,
        json: async () => ({
          success: true,
          jobs: body.jobs.map((job) => ({
            jobId: job.jobId,
            outputFilename: job.outputFilename,
            profileId: job.profile?.id ?? null,
          })),
        }),
      };
    });
    globalThis.fetch = fetchMock;

    await seedUploaderCreds();
    const res = await client
      .post("/api/v1/videos/upload")
      .set("Authorization", `Bearer ${uploaderKey}`)
      .attach("file", Buffer.from("tiny"), "clip.mp4");

    // The response is identical to the feature-disabled case — the upload
    // is never parked or delayed on the hash job.
    expect(res.status).toBe(201);
    expect(res.body.status).not.toBe("hashing");
    expect(res.body.fileVersions).toEqual([]);

    await flushBackgroundWork();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls.some((body) => body.jobs.some((job) => job.kind === "hash"))).toBe(true);
    expect(calls.some((body) => body.jobs.every((job) => job.kind !== "hash"))).toBe(true);
  });

  test("swallows a failed hash-job enqueue call: the upload is unaffected", async () => {
    process.env.ENABLE_DUPLICATE_UPLOAD_DETECTION = "true";
    const fetchMock = jest.fn(async (_url, options) => {
      const body = JSON.parse(String(options.body));
      if (body.jobs.some((job) => job.kind === "hash")) {
        return { ok: false, status: 500, json: async () => ({ success: false, error: "processing unreachable" }) };
      }
      return {
        ok: true,
        status: 202,
        json: async () => ({
          success: true,
          jobs: body.jobs.map((job) => ({
            jobId: job.jobId,
            outputFilename: job.outputFilename,
            profileId: job.profile?.id ?? null,
          })),
        }),
      };
    });
    globalThis.fetch = fetchMock;

    await seedUploaderCreds();
    const res = await client
      .post("/api/v1/videos/upload")
      .set("Authorization", `Bearer ${uploaderKey}`)
      .attach("file", Buffer.from("tiny"), "clip.mp4");

    expect(res.status).toBe(201);
    expect(res.body.status).not.toBe("hashing");
    expect(res.body.fileVersions).toEqual([]);
    await flushBackgroundWork();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
