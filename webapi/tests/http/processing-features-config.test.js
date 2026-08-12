import { Buffer } from "node:buffer";
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import { resetTables, seedUser, seedUserApiKey, setupSchema } from "../helpers/db.js";

/**
 * HTTP contract tests for the `ENABLE_TRANSCODING`/`ENABLE_VIDEO_IMPORTS`
 * gates in `lib/processing-features-config.js`. Both flags let a deployment
 * run without the `processing` container: when disabled, webapi must never
 * issue an outbound `fetch` toward it (asserted via a `globalThis.fetch`
 * mock that fails the test if invoked).
 */
describe("ENABLE_TRANSCODING / ENABLE_VIDEO_IMPORTS gates", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;
  /** @type {typeof fetch | undefined} */
  let originalFetch;
  /** @type {{id: number} & Record<string, unknown>} */
  let uploaderUser;
  const uploaderKey = "jt_test_processing_flags_key";

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.ENABLE_TRANSCODING;
    delete process.env.ENABLE_VIDEO_IMPORTS;
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

  /**
   * A `fetch` mock that fails the test immediately if called — used to prove
   * a disabled feature never contacts the processing service.
   *
   * @returns {jest.Mock} Mock matching the `globalThis.fetch` contract.
   */
  function unreachableFetchMock() {
    return jest.fn(() => {
      throw new Error("fetch should not be called when the feature is disabled");
    });
  }

  describe("GET /api/v1/config", () => {
    test("reports transcodingEnabled: true by default", async () => {
      delete process.env.ENABLE_TRANSCODING;
      const res = await client.get("/api/v1/config");
      expect(res.status).toBe(200);
      expect(res.body.transcodingEnabled).toBe(true);
    });

    test("reports transcodingEnabled: false when ENABLE_TRANSCODING=false", async () => {
      process.env.ENABLE_TRANSCODING = "false";
      const res = await client.get("/api/v1/config");
      expect(res.status).toBe(200);
      expect(res.body.transcodingEnabled).toBe(false);
    });
  });

  describe("POST /videos/upload with ENABLE_TRANSCODING=false", () => {
    test("finishes the upload without contacting the processing service", async () => {
      process.env.ENABLE_TRANSCODING = "false";
      globalThis.fetch = unreachableFetchMock();
      await seedUploaderCreds();

      const res = await client
        .post("/api/v1/videos/upload")
        .set("Authorization", `Bearer ${uploaderKey}`)
        .attach("file", Buffer.from("tiny"), "clip.mp4");

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("uploaded");
      expect(res.body.fileVersions).toEqual([]);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  describe("POST /videos/import with ENABLE_VIDEO_IMPORTS=false", () => {
    test("rejects the request without creating an upload row or contacting processing", async () => {
      process.env.ENABLE_VIDEO_IMPORTS = "false";
      globalThis.fetch = unreachableFetchMock();
      await seedUploaderCreds();

      const res = await client
        .post("/api/v1/videos/import")
        .set("Authorization", `Bearer ${uploaderKey}`)
        .send({ url: "https://example.com/video" });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("video_imports_disabled");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  describe("GET /videos/import/status with ENABLE_VIDEO_IMPORTS=false", () => {
    test("reports unavailable without contacting processing", async () => {
      process.env.ENABLE_VIDEO_IMPORTS = "false";
      globalThis.fetch = unreachableFetchMock();
      await seedUploaderCreds();

      const res = await client
        .get("/api/v1/videos/import/status")
        .set("Authorization", `Bearer ${uploaderKey}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ available: false });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });
});
