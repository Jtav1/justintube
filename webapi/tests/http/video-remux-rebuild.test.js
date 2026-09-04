import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { mediaDir } from "../../lib/media-meta.js";
import { createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedMetadata,
  seedUpload,
  seedUser,
  seedUserApiKey,
  seedVideoThumbnail,
  setupSchema,
} from "../helpers/db.js";
import { OriginalUpload, Role } from "../../lib/models/index.js";

/**
 * Writes a fixture file under the test media root at a given relative storage
 * path, creating parent directories as needed. Mirrors the identical helper
 * in videos.test.js / video-thumbnail-regenerate.test.js.
 *
 * @param {string} relativeStoragePath Path relative to `mediaDir`.
 * @param {Buffer} contents File contents to write.
 * @returns {string} The absolute path the file was written to.
 */
function writeMediaFixture(relativeStoragePath, contents) {
  const absolutePath = join(mediaDir, relativeStoragePath);
  mkdirSync(join(absolutePath, ".."), { recursive: true });
  writeFileSync(absolutePath, contents);
  return absolutePath;
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
        jobs: body.jobs.map((job) => ({ jobId: job.jobId, outputFilename: job.outputFilename })),
      }),
    };
  });
}

/**
 * HTTP contract tests for `POST /videos/:id/remux/rebuild` — an admin-only
 * action that rebuilds an audio upload's link-unfurl embed video (a
 * thumbnail+audio MP4 muxed so bots like Discord's `og:video` unfurler have
 * something playable to embed). A no-op for real videos.
 */
describe("POST /videos/:id/remux/rebuild", () => {
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
    adminKey = `jt_test_${admin.id}_remux_rebuild_key`;
    await seedUserApiKey(admin.id, adminKey);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await resetTables();
  });

  /**
   * Seeds an owner user plus an upload+metadata row they own.
   *
   * @param {object} [overrides] Passed through to seedUpload.
   * @returns {Promise<{ ownerId: number, uploadId: number }>}
   */
  async function seedOwnedVideo(overrides = {}) {
    const owner = await seedUser({ emailVerified: true });
    const upload = await seedUpload({ userId: owner.id, ...overrides });
    await seedMetadata(upload.id, { title: "Owned video" });
    return { ownerId: owner.id, uploadId: upload.id };
  }

  test("rejects an unauthenticated request", async () => {
    const { uploadId } = await seedOwnedVideo({ mediaType: "audio" });
    const res = await client
      .post(`/api/v1/videos/${uploadId}/remux/rebuild`)
      .set("Authorization", "Bearer jt_not_a_real_key")
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("rejects the video's own owner when not an admin", async () => {
    const owner = await seedUser({ emailVerified: true });
    const ownerKey = `jt_test_${owner.id}_remux_rebuild_owner_key`;
    await seedUserApiKey(owner.id, ownerKey);
    const upload = await seedUpload({ userId: owner.id, mediaType: "audio" });
    await seedMetadata(upload.id, { title: "Owned audio" });

    const res = await client
      .post(`/api/v1/videos/${upload.id}/remux/rebuild`)
      .set("Authorization", `Bearer ${ownerKey}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("returns 404 for an unknown video id", async () => {
    const res = await client
      .post("/api/v1/videos/999999/remux/rebuild")
      .set("Authorization", `Bearer ${adminKey}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("is a harmless no-op for a real video (hasVideoStream true)", async () => {
    const { uploadId } = await seedOwnedVideo();
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock;

    const res = await client
      .post(`/api/v1/videos/${uploadId}/remux/rebuild`)
      .set("Authorization", `Bearer ${adminKey}`)
      .send({});

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ success: true, status: "not_applicable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rebuilds the embed video for an audio-in-container upload, using its current thumbnail", async () => {
    const { uploadId } = await seedOwnedVideo({
      videoId: "remuxvid1",
      mediaType: "audio",
      embedVideoStoragePath: "transcoded/_unowned/old-embed.mp4",
      embedVideoWidth: 640,
      embedVideoHeight: 360,
      embedVideoIsDefault: false,
    });
    const seededRow = await OriginalUpload.findByPk(uploadId);
    const thumbnail = await seedVideoThumbnail(uploadId, { thumbnailFilename: "cover.jpg" });
    const oldEmbedPath = writeMediaFixture(seededRow.embedVideoStoragePath, Buffer.from("old-embed"));

    const fetchMock = acceptJobFetchMock();
    globalThis.fetch = fetchMock;

    const res = await client
      .post(`/api/v1/videos/${uploadId}/remux/rebuild`)
      .set("Authorization", `Bearer ${adminKey}`)
      .send({});

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ success: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(payload.filename).toBe(seededRow.storagePath.replace(/^original\//, ""));
    expect(payload.jobs).toHaveLength(1);
    expect(payload.jobs[0]).toMatchObject({
      kind: "embed",
      thumbnailFilename: thumbnail.thumbnailFilename,
      isDefault: false,
    });
    expect(payload.jobs[0].jobId).toMatch(/^embed-remuxvid1-/);

    // The stale embed container is gone immediately - a fresh one lands
    // later via the processing service's embed-complete callback.
    expect(existsSync(oldEmbedPath)).toBe(false);
    const row = await OriginalUpload.findByPk(uploadId);
    expect(row.embedVideoStoragePath).toBeNull();
    expect(row.embedVideoWidth).toBeNull();
    expect(row.embedVideoHeight).toBeNull();
    expect(row.embedVideoIsDefault).toBe(false);
  });

  test("falls back to the default placeholder thumbnail when the upload has none", async () => {
    const { uploadId } = await seedOwnedVideo({ mediaType: "audio" });
    globalThis.fetch = acceptJobFetchMock();

    const res = await client
      .post(`/api/v1/videos/${uploadId}/remux/rebuild`)
      .set("Authorization", `Bearer ${adminKey}`)
      .send({});

    expect(res.status).toBe(202);
    const payload = JSON.parse(String(globalThis.fetch.mock.calls[0][1].body));
    expect(payload.jobs[0]).toMatchObject({
      thumbnailFilename: "default-audio-thumbnail.png",
      isDefault: true,
    });
  });

  test("returns 502 and leaves the existing embed video in place when enqueueing fails", async () => {
    const { uploadId } = await seedOwnedVideo({
      mediaType: "audio",
      embedVideoStoragePath: "transcoded/_unowned/kept-embed.mp4",
    });
    const seededRow = await OriginalUpload.findByPk(uploadId);
    const embedPath = writeMediaFixture(seededRow.embedVideoStoragePath, Buffer.from("kept-embed"));
    globalThis.fetch = jest.fn(async () => {
      throw new Error("network down");
    });

    const res = await client
      .post(`/api/v1/videos/${uploadId}/remux/rebuild`)
      .set("Authorization", `Bearer ${adminKey}`)
      .send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("processing_unavailable");
    expect(existsSync(embedPath)).toBe(true);
    const row = await OriginalUpload.findByPk(uploadId);
    expect(row.embedVideoStoragePath).toBe(seededRow.embedVideoStoragePath);
  });
});
