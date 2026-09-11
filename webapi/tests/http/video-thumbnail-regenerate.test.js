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
import { OriginalUpload, Role, VideoThumbnail } from "../../lib/models/index.js";

/**
 * Writes a fixture file under the test media root at a given relative storage
 * path (e.g. "thumbnails/foo.jpg"), creating parent directories as needed.
 * Mirrors the identical helper in `videos.test.js`.
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
 * HTTP contract tests for `POST /videos/:id/thumbnail/regenerate` — lets the
 * video owner (or an admin) request a fresh auto-generated thumbnail at a
 * given timestamp (video only), or an admin re-run the same job a fresh
 * upload gets with no explicit timestamp (video or audio — for audio this
 * re-attempts embedded cover art extraction, falling back to the bundled
 * placeholder when none is found), overwriting whatever VIDEO_THUMBNAIL
 * currently exists once processing finishes.
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
   * Seeds a user with the given role name and an API key for Bearer auth.
   *
   * @param {string} roleName Role name (`admin`, `viewer`, …).
   * @param {string} rawKey Plaintext API key for Authorization headers.
   * @returns {Promise<{id: number} & Record<string, unknown>>} Seeded user record.
   */
  async function seedUserWithRoleAndKey(roleName, rawKey) {
    const role = await Role.findOne({ where: { name: roleName } });
    const user = await seedUser({ roleId: role?.id ?? null, emailVerified: true });
    await seedUserApiKey(user.id, rawKey);
    return user;
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

  test("returns 403 forbidden when a non-admin owner omits thumbnailTimestamp", async () => {
    const { ownerKey, uploadId } = await seedOwnedVideo();

    const res = await client
      .post(`/api/v1/videos/${uploadId}/thumbnail/regenerate`)
      .set("Authorization", `Bearer ${ownerKey}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("admin can queue a random thumbnail regeneration by omitting thumbnailTimestamp", async () => {
    const { uploadId } = await seedOwnedVideo({ videoId: "regenvid2", fileExtension: "mp4" });
    const seededRow = await OriginalUpload.findByPk(uploadId);
    await seededRow.update({ thumbnailTimestampTenths: 50 });
    await seedUserWithRoleAndKey("admin", "admin-thumb-regen-key");
    const fetchMock = acceptJobFetchMock();
    globalThis.fetch = fetchMock;

    const res = await client
      .post(`/api/v1/videos/${uploadId}/thumbnail/regenerate`)
      .set("Authorization", "Bearer admin-thumb-regen-key")
      .send({});

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ success: true });

    const payload = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(payload.jobs[0]).toMatchObject({ kind: "thumbnail", timestampSeconds: null });

    const row = await OriginalUpload.findByPk(uploadId);
    expect(row.thumbnailTimestampTenths).toBeNull();
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

  test("returns 400 invalid_body when a specific thumbnailTimestamp is given for an audio upload", async () => {
    const { ownerKey, uploadId } = await seedOwnedVideo({ mediaType: "audio" });

    const res = await client
      .post(`/api/v1/videos/${uploadId}/thumbnail/regenerate`)
      .set("Authorization", `Bearer ${ownerKey}`)
      .send({ thumbnailTimestamp: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("admin can queue a thumbnail regeneration for an audio upload by omitting thumbnailTimestamp", async () => {
    const { uploadId } = await seedOwnedVideo({
      videoId: "regenaud1",
      mediaType: "audio",
      fileExtension: "mp3",
    });
    const seededRow = await OriginalUpload.findByPk(uploadId);
    await seedUserWithRoleAndKey("admin", "admin-thumb-regen-audio-key");
    const fetchMock = acceptJobFetchMock();
    globalThis.fetch = fetchMock;

    const res = await client
      .post(`/api/v1/videos/${uploadId}/thumbnail/regenerate`)
      .set("Authorization", "Bearer admin-thumb-regen-audio-key")
      .send({});

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ success: true });

    const payload = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(payload.filename).toBe(seededRow.storagePath.replace(/^original\//, ""));
    expect(payload.jobs[0]).toMatchObject({
      kind: "thumbnail",
      jobId: expect.stringMatching(/^thumbnail-regenaud1-/),
      timestampSeconds: null,
    });
  });

  test("admin regenerating an audio thumbnail falls back to the default placeholder when no cover art is found", async () => {
    const { uploadId } = await seedOwnedVideo({ mediaType: "audio", hasVideoStream: false });
    const thumbnail = await seedVideoThumbnail(uploadId);
    const thumbnailPath = writeMediaFixture(
      `thumbnails/${thumbnail.thumbnailFilename}`,
      Buffer.from("old-cover-art"),
    );
    await seedUserWithRoleAndKey("admin", "admin-thumb-regen-audio-fallback-key");
    globalThis.fetch = acceptJobFetchMock();

    const res = await client
      .post(`/api/v1/videos/${uploadId}/thumbnail/regenerate`)
      .set("Authorization", "Bearer admin-thumb-regen-audio-fallback-key")
      .send({});

    expect(res.status).toBe(202);

    // The stale thumbnail (row + file) is dropped immediately once the
    // extraction job is queued; without a fresh VIDEO_THUMBNAIL row,
    // GET /videos/:id/thumbnail already falls back to serving the bundled
    // placeholder for any audio upload — this is what "resets to the
    // default png" actually means server-side, not a special-cased row.
    expect(existsSync(thumbnailPath)).toBe(false);
    expect(await VideoThumbnail.findOne({ where: { originalUploadId: uploadId } })).toBeNull();
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
    expect(payload.jobs).toHaveLength(1);
    // jobId/outputFilename each embed a fresh random UUID (not the fixed
    // videoId) so a second regeneration doesn't silently no-op against
    // BullMQ's dedup on the first, already-completed job with the same id -
    // see the rationale comment above the enqueue call in routes/videos.js.
    expect(payload.jobs[0].jobId).toMatch(/^thumbnail-regenvid1-/);
    expect(payload.jobs[0]).toMatchObject({
      outputFilename: expect.stringMatching(new RegExp(`^${ownerId}/[0-9a-f-]{36}\\.webp$`)),
      kind: "thumbnail",
      timestampSeconds: 12.5,
    });

    const row = await OriginalUpload.findByPk(uploadId);
    expect(row.thumbnailTimestampTenths).toBe(125);
  });

  test("deletes the existing thumbnail row and file once regeneration is queued", async () => {
    const { ownerKey, uploadId } = await seedOwnedVideo({ skipThumbnail: true });
    const thumbnail = await seedVideoThumbnail(uploadId);
    const thumbnailPath = writeMediaFixture(
      `thumbnails/${thumbnail.thumbnailFilename}`,
      Buffer.from("thumb"),
    );
    globalThis.fetch = acceptJobFetchMock();

    const res = await client
      .post(`/api/v1/videos/${uploadId}/thumbnail/regenerate`)
      .set("Authorization", `Bearer ${ownerKey}`)
      .send({ thumbnailTimestamp: 5 });

    expect(res.status).toBe(202);
    expect(existsSync(thumbnailPath)).toBe(false);
    expect(await VideoThumbnail.findOne({ where: { originalUploadId: uploadId } })).toBeNull();

    // A manually-uploaded thumbnail sets skipThumbnail so no auto-generation
    // could ever overwrite it - regeneration must clear that flag, or the
    // completion callback would silently drop the newly-generated frame.
    const row = await OriginalUpload.findByPk(uploadId);
    expect(row.skipThumbnail).toBe(false);
  });

  test("succeeds with no existing thumbnail to delete", async () => {
    const { ownerKey, uploadId } = await seedOwnedVideo();
    globalThis.fetch = acceptJobFetchMock();

    const res = await client
      .post(`/api/v1/videos/${uploadId}/thumbnail/regenerate`)
      .set("Authorization", `Bearer ${ownerKey}`)
      .send({ thumbnailTimestamp: 5 });

    expect(res.status).toBe(202);
    expect(await VideoThumbnail.findOne({ where: { originalUploadId: uploadId } })).toBeNull();
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

  test("leaves the existing thumbnail in place when enqueueing fails", async () => {
    const { ownerKey, uploadId } = await seedOwnedVideo();
    const thumbnail = await seedVideoThumbnail(uploadId);
    const thumbnailPath = writeMediaFixture(
      `thumbnails/${thumbnail.thumbnailFilename}`,
      Buffer.from("thumb"),
    );
    globalThis.fetch = jest.fn(async () => {
      throw new Error("network down");
    });

    const res = await client
      .post(`/api/v1/videos/${uploadId}/thumbnail/regenerate`)
      .set("Authorization", `Bearer ${ownerKey}`)
      .send({ thumbnailTimestamp: 5 });

    expect(res.status).toBe(502);
    expect(existsSync(thumbnailPath)).toBe(true);
    expect(await VideoThumbnail.findOne({ where: { originalUploadId: uploadId } })).not.toBeNull();
  });
});
