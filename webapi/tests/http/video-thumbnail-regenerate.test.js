import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedMetadata,
  seedUpload,
  seedUser,
  seedUserApiKey,
  setupSchema,
} from "../helpers/db.js";
import { OriginalUpload } from "../../lib/models/index.js";

/**
 * HTTP contract tests for `POST /videos/:id/thumbnail/regenerate` — lets the
 * video owner (or an admin) request a fresh auto-generated thumbnail at a
 * given timestamp, overwriting whatever VIDEO_THUMBNAIL currently exists once
 * processing finishes the frame extraction.
 */
describe("POST /videos/:id/thumbnail/regenerate", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;
  /** @type {typeof fetch | undefined} */
  let originalFetch;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await resetTables();
  });

  /**
   * Seeds an owner user (with an API key) plus a video upload+metadata row
   * they own.
   *
   * @param {object} [overrides] Passed through to seedUpload.
   * @returns {Promise<{ ownerKey: string, ownerId: number, uploadId: number }>}
   */
  async function seedOwnedVideo(overrides = {}) {
    const owner = await seedUser({ emailVerified: true });
    const ownerKey = `jt_test_${owner.id}_thumb_regen_key`;
    await seedUserApiKey(owner.id, ownerKey);
    const upload = await seedUpload({ userId: owner.id, ...overrides });
    await seedMetadata(upload.id, { title: "Owned video" });
    return { ownerKey, ownerId: owner.id, uploadId: upload.id };
  }

  /**
   * Builds a `fetch` mock answering `POST /transcode` as accepted.
   *
   * @returns {jest.Mock}
   */
  function acceptJobFetchMock() {
    return jest.fn(async (_url, options) => {
      const body = JSON.parse(String(options.body));
      return {
        ok: true,
        status: 202,
        json: async () => ({
          success: true,
          jobs: body.jobs.map((job) => ({
            jobId: job.jobId,
            outputFilename: job.outputFilename,
          })),
        }),
      };
    });
  }

  test("rejects an unauthenticated request", async () => {
    const { uploadId } = await seedOwnedVideo();
    const res = await client
      .post(`/api/v1/videos/${uploadId}/thumbnail/regenerate`)
      .set("Authorization", "Bearer jt_not_a_real_key")
      .send({ thumbnailTimestamp: 5 });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("rejects a user who is not the owner or an admin", async () => {
    const { uploadId } = await seedOwnedVideo();
    const stranger = await seedUser({ emailVerified: true });
    const strangerKey = "jt_test_stranger_thumb_regen_key";
    await seedUserApiKey(stranger.id, strangerKey);

    const res = await client
      .post(`/api/v1/videos/${uploadId}/thumbnail/regenerate`)
      .set("Authorization", `Bearer ${strangerKey}`)
      .send({ thumbnailTimestamp: 5 });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("returns 404 for an unknown video id", async () => {
    const owner = await seedUser({ emailVerified: true });
    const ownerKey = "jt_test_unknown_video_thumb_regen_key";
    await seedUserApiKey(owner.id, ownerKey);

    const res = await client
      .post("/api/v1/videos/999999/thumbnail/regenerate")
      .set("Authorization", `Bearer ${ownerKey}`)
      .send({ thumbnailTimestamp: 5 });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("returns 400 invalid_body when thumbnailTimestamp is omitted", async () => {
    const { ownerKey, uploadId } = await seedOwnedVideo();

    const res = await client
      .post(`/api/v1/videos/${uploadId}/thumbnail/regenerate`)
      .set("Authorization", `Bearer ${ownerKey}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("returns 400 invalid_body for a negative thumbnailTimestamp", async () => {
    const { ownerKey, uploadId } = await seedOwnedVideo();

    const res = await client
      .post(`/api/v1/videos/${uploadId}/thumbnail/regenerate`)
      .set("Authorization", `Bearer ${ownerKey}`)
      .send({ thumbnailTimestamp: -1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("returns 400 invalid_body for an audio upload", async () => {
    const { ownerKey, uploadId } = await seedOwnedVideo({ mediaType: "audio" });

    const res = await client
      .post(`/api/v1/videos/${uploadId}/thumbnail/regenerate`)
      .set("Authorization", `Bearer ${ownerKey}`)
      .send({ thumbnailTimestamp: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("owner can queue thumbnail regeneration at a timestamp", async () => {
    const { ownerId, ownerKey, uploadId } = await seedOwnedVideo({
      videoId: "regenvid1",
      fileExtension: "mp4",
    });
    const seededRow = await OriginalUpload.findByPk(uploadId);
    const fetchMock = acceptJobFetchMock();
    globalThis.fetch = fetchMock;

    const res = await client
      .post(`/api/v1/videos/${uploadId}/thumbnail/regenerate`)
      .set("Authorization", `Bearer ${ownerKey}`)
      .send({ thumbnailTimestamp: 12.5 });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ success: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://processing.test:3001/transcode");
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    // Derived from storagePath (uuid-based), not reconstructed from videoId.
    expect(payload.filename).toBe(seededRow.storagePath.replace(/^original\//, ""));
    expect(payload.jobs).toEqual([
      {
        jobId: "regenvid1",
        outputFilename: `${ownerId}/regenvid1.webp`,
        kind: "thumbnail",
        timestampSeconds: 12.5,
      },
    ]);

    const row = await OriginalUpload.findByPk(uploadId);
    expect(row.thumbnailTimestampTenths).toBe(125);
  });

  test("returns 502 when the processing service is unreachable", async () => {
    const { ownerKey, uploadId } = await seedOwnedVideo();
    globalThis.fetch = jest.fn(async () => {
      throw new Error("network down");
    });

    const res = await client
      .post(`/api/v1/videos/${uploadId}/thumbnail/regenerate`)
      .set("Authorization", `Bearer ${ownerKey}`)
      .send({ thumbnailTimestamp: 5 });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("processing_unavailable");
  });
});
