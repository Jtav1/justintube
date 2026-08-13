import { Buffer } from "node:buffer";
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import { resetTables, seedUser, seedUserApiKey, setupSchema } from "../helpers/db.js";

/**
 * HTTP contract tests for the `ENABLE_DUPLICATE_UPLOAD_DETECTION` gate in
 * `routes/uploads.js` (`requestDuplicateCheck`). Verifies: disabled by
 * default (unchanged upload behavior); when enabled, an upload is parked in
 * "hashing" and only a hash job is enqueued (no rendition/thumbnail jobs
 * yet); and a failed hash-job enqueue call fails open, proceeding to the
 * normal transcode batch exactly as if the feature were off.
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

  test("defaults to off: an upload proceeds straight to transcode, never enqueuing a hash job", async () => {
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("when enabled, parks the upload in hashing and enqueues only a hash job", async () => {
    process.env.ENABLE_DUPLICATE_UPLOAD_DETECTION = "true";
    const fetchMock = jest.fn(async (_url, options) => {
      const body = JSON.parse(String(options.body));
      expect(body.jobs).toEqual([{ jobId: expect.stringMatching(/^hash-/), kind: "hash" }]);
      return { ok: true, status: 202, json: async () => ({ success: true, jobs: [], skipped: [] }) };
    });
    globalThis.fetch = fetchMock;

    await seedUploaderCreds();
    const res = await client
      .post("/api/v1/videos/upload")
      .set("Authorization", `Bearer ${uploaderKey}`)
      .attach("file", Buffer.from("tiny"), "clip.mp4");

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("hashing");
    expect(res.body.fileVersions).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("fails open when the hash-job enqueue call fails: proceeds to the normal transcode batch", async () => {
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
    // First call attempts the hash job (fails), second call is the normal
    // finalize batch (fail-open fallback) - never left stuck.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
