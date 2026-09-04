import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import { resetTables, seedMetadata, seedUpload, seedUser, seedUserApiKey, setupSchema } from "../helpers/db.js";
import { OriginalUpload, Role } from "../../lib/models/index.js";

/**
 * Builds a `fetch` mock answering `POST /transcode` with a given
 * `source.hasVideoStream` value.
 *
 * @param {boolean|null} hasVideoStream Value to report back as `source.hasVideoStream`.
 * @returns {jest.Mock}
 */
function probeFetchMock(hasVideoStream) {
  return jest.fn(async () => ({
    ok: true,
    status: 202,
    json: async () => ({
      success: true,
      jobs: [],
      skipped: [],
      source: { videoWidth: null, videoHeight: null, durationSeconds: null, hasVideoStream },
    }),
  }));
}

/**
 * HTTP contract tests for `POST /videos/:id/media-type/repopulate` — an
 * admin-only repair action that re-derives an upload's mediaType via the
 * processing service's ffprobe and persists it, regardless of whatever
 * mediaType (if any) is already recorded.
 */
describe("POST /videos/:id/media-type/repopulate", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;
  /** @type {typeof fetch | undefined} */
  let originalFetch;
  /** @type {string} */
  let adminKey;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    const adminRole = await Role.findOne({ where: { name: "admin" } });
    const admin = await seedUser({ roleId: adminRole?.id ?? null, emailVerified: true });
    adminKey = `jt_test_${admin.id}_repopulate_media_type_key`;
    await seedUserApiKey(admin.id, adminKey);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await resetTables();
  });

  test("rejects an unauthenticated request", async () => {
    const upload = await seedUpload();
    const res = await client
      .post(`/api/v1/videos/${upload.id}/media-type/repopulate`)
      .set("Authorization", "Bearer jt_not_a_real_key")
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("rejects the video's own owner when not an admin", async () => {
    const owner = await seedUser({ emailVerified: true });
    const ownerKey = `jt_test_${owner.id}_repopulate_media_type_owner_key`;
    await seedUserApiKey(owner.id, ownerKey);
    const upload = await seedUpload({ userId: owner.id });

    const res = await client
      .post(`/api/v1/videos/${upload.id}/media-type/repopulate`)
      .set("Authorization", `Bearer ${ownerKey}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("returns 404 for an unknown upload id", async () => {
    const res = await client
      .post("/api/v1/videos/999999/media-type/repopulate")
      .set("Authorization", `Bearer ${adminKey}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("works for an upload with no VIDEO_METADATA row", async () => {
    // Deliberately no seedMetadata() call - this route loads the upload
    // directly (not via loadUploadWithMetadata), since a broken row missing
    // mediaType may not have metadata either.
    const upload = await seedUpload({ videoId: "repopvid1" });
    globalThis.fetch = probeFetchMock(true);

    const res = await client
      .post(`/api/v1/videos/${upload.id}/media-type/repopulate`)
      .set("Authorization", `Bearer ${adminKey}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, mediaType: "video" });
  });

  test("re-derives and persists mediaType=video when the probe finds a real video stream", async () => {
    const upload = await seedUpload({ videoId: "repopvid2", mediaType: "audio" });
    await seedMetadata(upload.id, { title: "Mislabeled upload" });
    const fetchMock = probeFetchMock(true);
    globalThis.fetch = fetchMock;

    const res = await client
      .post(`/api/v1/videos/${upload.id}/media-type/repopulate`)
      .set("Authorization", `Bearer ${adminKey}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, mediaType: "video" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(payload.jobs).toEqual([{ jobId: "hash-repopvid2", kind: "hash" }]);

    const row = await OriginalUpload.findByPk(upload.id);
    expect(row.mediaType).toBe("video");
  });

  test("re-derives and persists mediaType=audio when the probe finds no video stream", async () => {
    const upload = await seedUpload({ videoId: "repopvid3" });
    await seedMetadata(upload.id, { title: "Mislabeled upload" });
    globalThis.fetch = probeFetchMock(false);

    const res = await client
      .post(`/api/v1/videos/${upload.id}/media-type/repopulate`)
      .set("Authorization", `Bearer ${adminKey}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, mediaType: "audio" });

    const row = await OriginalUpload.findByPk(upload.id);
    expect(row.mediaType).toBe("audio");
  });

  test("returns 502 media_type_undetermined when the probe can't tell", async () => {
    const upload = await seedUpload();
    globalThis.fetch = probeFetchMock(null);

    const res = await client
      .post(`/api/v1/videos/${upload.id}/media-type/repopulate`)
      .set("Authorization", `Bearer ${adminKey}`)
      .send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("media_type_undetermined");

    const row = await OriginalUpload.findByPk(upload.id);
    expect(row.mediaType).toBe("video");
  });

  test("returns 502 when the processing service is unreachable", async () => {
    const upload = await seedUpload();
    globalThis.fetch = jest.fn(async () => {
      throw new Error("network down");
    });

    const res = await client
      .post(`/api/v1/videos/${upload.id}/media-type/repopulate`)
      .set("Authorization", `Bearer ${adminKey}`)
      .send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("processing_unavailable");
  });
});
