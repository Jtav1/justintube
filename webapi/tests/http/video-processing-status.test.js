import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import { OriginalUpload } from "../../lib/models/index.js";
import {
  resetTables,
  seedFileVersion,
  seedUpload,
  seedUser,
  seedUserApiKey,
  seedVideoThumbnail,
  setupSchema,
} from "../helpers/db.js";

/**
 * HTTP contract tests for `GET /videos/:id/processing-status`, extended to
 * report outstanding "core" jobs (rendition, thumbnail, normalize) still in
 * flight for a video, backing VideoCard's (webview) per-video progress
 * overlay.
 */
describe("GET /videos/:id/processing-status", () => {
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
   * Seeds an owner user (with an API key) plus an upload row they own.
   *
   * @param {object} [overrides] Passed through to seedUpload.
   * @returns {Promise<{ ownerKey: string, ownerId: number, uploadId: number }>}
   */
  async function seedOwnedUpload(overrides = {}) {
    const owner = await seedUser({ emailVerified: true });
    const ownerKey = `jt_test_${owner.id}_procstatus_key`;
    await seedUserApiKey(owner.id, ownerKey);
    const upload = await seedUpload({ userId: owner.id, ...overrides });
    return { ownerKey, ownerId: owner.id, uploadId: upload.id };
  }

  /**
   * Builds a `fetch` mock answering `GET /queue/jobs` with a fixed job list.
   *
   * @param {Array<object>} jobs Jobs to report.
   * @returns {jest.Mock} Fetch mock.
   */
  function queueJobsFetchMock(jobs) {
    return jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, jobs }),
    }));
  }

  test("rejects an unauthenticated request", async () => {
    const { uploadId } = await seedOwnedUpload();
    const res = await client.get(`/api/v1/videos/${uploadId}/processing-status`);
    expect(res.status).toBe(401);
  });

  test("rejects a user who is not the owner or an admin", async () => {
    const { uploadId } = await seedOwnedUpload();
    const stranger = await seedUser({ emailVerified: true });
    const strangerKey = "jt_test_stranger_procstatus_key";
    await seedUserApiKey(stranger.id, strangerKey);

    const res = await client
      .get(`/api/v1/videos/${uploadId}/processing-status`)
      .set("Authorization", `Bearer ${strangerKey}`);

    expect(res.status).toBe(403);
  });

  test("returns 404 for an unknown video id", async () => {
    const owner = await seedUser({ emailVerified: true });
    const ownerKey = "jt_test_unknown_procstatus_key";
    await seedUserApiKey(owner.id, ownerKey);

    const res = await client
      .get("/api/v1/videos/999999/processing-status")
      .set("Authorization", `Bearer ${ownerKey}`);

    expect(res.status).toBe(404);
  });

  test("short-circuits to an empty outstandingJobs with no processing call when nothing could be in flight", async () => {
    const { ownerKey, uploadId } = await seedOwnedUpload({ status: "ready", skipThumbnail: true });
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock;

    const res = await client
      .get(`/api/v1/videos/${uploadId}/processing-status`)
      .set("Authorization", `Bearer ${ownerKey}`);

    expect(res.status).toBe(200);
    expect(res.body.outstandingJobs).toEqual([]);
    expect(res.body.jobsRemaining).toBe(0);
    expect(res.body.jobsStatusUnknown).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("short-circuits a failed upload to empty, even with no thumbnail and no processing call", async () => {
    const { ownerKey, uploadId } = await seedOwnedUpload({ status: "failed" });
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock;

    const res = await client
      .get(`/api/v1/videos/${uploadId}/processing-status`)
      .set("Authorization", `Bearer ${ownerKey}`);

    expect(res.status).toBe(200);
    expect(res.body.outstandingJobs).toEqual([]);
    expect(res.body.jobsStatusUnknown).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("reports a normalize job purely from upload.status, without calling processing", async () => {
    const { ownerKey, uploadId } = await seedOwnedUpload({
      status: "converting",
      skipThumbnail: true,
    });
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock;

    const res = await client
      .get(`/api/v1/videos/${uploadId}/processing-status`)
      .set("Authorization", `Bearer ${ownerKey}`);

    expect(res.status).toBe(200);
    expect(res.body.outstandingJobs).toEqual([{ kind: "normalize", state: "active" }]);
    expect(res.body.jobsRemaining).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("matches a pending rendition and an unthumbnailed upload against live processing jobs", async () => {
    const { ownerKey, uploadId } = await seedOwnedUpload({ status: "processing" });
    const version = await seedFileVersion(uploadId, { status: "pending", resolution: "720p" });
    const upload = await OriginalUpload.findByPk(uploadId);
    globalThis.fetch = queueJobsFetchMock([
      { jobId: version.uuidName, kind: "rendition", name: "ffmpeg-transcode", state: "active", truncated: false },
      { jobId: upload.videoId, kind: "thumbnail", name: "ffmpeg-thumbnail", state: "waiting", truncated: false },
    ]);

    const res = await client
      .get(`/api/v1/videos/${uploadId}/processing-status`)
      .set("Authorization", `Bearer ${ownerKey}`);

    expect(res.status).toBe(200);
    expect(res.body.outstandingJobs).toEqual([
      { kind: "rendition", resolution: "720p", state: "active" },
      { kind: "thumbnail", state: "waiting" },
    ]);
    expect(res.body.jobsRemaining).toBe(2);
    expect(res.body.jobsStatusUnknown).toBe(false);
  });

  test("surfaces an orphaned pending rendition (no matching live job) as state: unknown", async () => {
    const { ownerKey, uploadId } = await seedOwnedUpload({ status: "processing", skipThumbnail: true });
    await seedFileVersion(uploadId, { status: "pending", resolution: "480p" });
    globalThis.fetch = queueJobsFetchMock([]);

    const res = await client
      .get(`/api/v1/videos/${uploadId}/processing-status`)
      .set("Authorization", `Bearer ${ownerKey}`);

    expect(res.status).toBe(200);
    expect(res.body.outstandingJobs).toEqual([
      { kind: "rendition", resolution: "480p", state: "unknown" },
    ]);
  });

  test("does not report a thumbnail entry once a VIDEO_THUMBNAIL row exists", async () => {
    const { ownerKey, uploadId } = await seedOwnedUpload({ status: "processing" });
    await seedFileVersion(uploadId, { status: "pending", resolution: "1080p" });
    await seedVideoThumbnail(uploadId);
    globalThis.fetch = queueJobsFetchMock([]);

    const res = await client
      .get(`/api/v1/videos/${uploadId}/processing-status`)
      .set("Authorization", `Bearer ${ownerKey}`);

    expect(res.status).toBe(200);
    expect(res.body.outstandingJobs).toEqual([
      { kind: "rendition", resolution: "1080p", state: "unknown" },
    ]);
  });

  test("sets jobsStatusUnknown: true (not an empty confirmed list) when processing is unreachable", async () => {
    const { ownerKey, uploadId } = await seedOwnedUpload({ status: "processing" });
    await seedFileVersion(uploadId, { status: "pending", resolution: "720p" });
    globalThis.fetch = jest.fn(async () => {
      throw new Error("network down");
    });

    const res = await client
      .get(`/api/v1/videos/${uploadId}/processing-status`)
      .set("Authorization", `Bearer ${ownerKey}`);

    expect(res.status).toBe(200);
    expect(res.body.jobsStatusUnknown).toBe(true);
    expect(res.body.outstandingJobs).toEqual([]);
  });
});
