import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, jest, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import {
  queryRows,
  resetTables,
  seedMetadata,
  seedUpload,
  setupSchema,
} from "../helpers/db.js";

const TOKEN = "test-internal-token";

/**
 * Builds a `thumbnail-<videoId>-<uuid>` BullMQ jobId, matching what
 * `routes/uploads.js`/`routes/videos.js` actually enqueue thumbnail jobs
 * with, for use as the `:uploadUuid` route param in these callback tests.
 *
 * @param {import('sequelize').Model} upload Seeded upload.
 * @returns {string} A well-formed thumbnail jobId for `upload`.
 */
function thumbnailJobId(upload) {
  return `thumbnail-${upload.videoId}-${randomUUID()}`;
}

/**
 * HTTP tests for the processing → API thumbnail-generation callback.
 */
describe("POST /internal/thumbnails/:uploadUuid/complete", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("rejects missing bearer token", async () => {
    const upload = await seedUpload();

    const res = await client
      .post(`/internal/thumbnails/${thumbnailJobId(upload)}/complete`)
      .send({ thumbnailFilename: `${upload.videoId}.webp` });

    expect(res.status).toBe(401);
  });

  test("returns 400 when thumbnailFilename is missing", async () => {
    const upload = await seedUpload();

    const res = await client
      .post(`/internal/thumbnails/${thumbnailJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("returns 400 when the jobId isn't a well-formed thumbnail-<videoId>-<uuid>", async () => {
    const res = await client
      .post("/internal/thumbnails/not-a-thumbnail-job/complete")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ thumbnailFilename: "whatever.webp" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_uuid");
  });

  test("returns 404 for an unknown upload videoId", async () => {
    const res = await client
      .post(`/internal/thumbnails/thumbnail-000000-${randomUUID()}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ thumbnailFilename: "whatever.webp" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("creates a VIDEO_THUMBNAIL row on first success", async () => {
    const upload = await seedUpload();
    const thumbnailFilename = `${upload.videoId}.webp`;

    const res = await client
      .post(`/internal/thumbnails/${thumbnailJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ thumbnailFilename });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      videoId: upload.videoId,
      status: "complete",
    });

    const rows = await queryRows(
      "SELECT * FROM VIDEO_THUMBNAIL WHERE original_upload_id = :id",
      { id: upload.id },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].thumbnail_filename).toBe(thumbnailFilename);
  });

  test("updates the existing row instead of duplicating on re-run", async () => {
    const upload = await seedUpload();
    const firstFilename = `${upload.videoId}.webp`;
    const secondFilename = `${upload.videoId}-2.webp`;

    const first = await client
      .post(`/internal/thumbnails/${thumbnailJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ thumbnailFilename: firstFilename });
    expect(first.status).toBe(200);

    const second = await client
      .post(`/internal/thumbnails/${thumbnailJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ thumbnailFilename: secondFilename });
    expect(second.status).toBe(200);

    const rows = await queryRows(
      "SELECT * FROM VIDEO_THUMBNAIL WHERE original_upload_id = :id",
      { id: upload.id },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].thumbnail_filename).toBe(secondFilename);
  });

  test("reflects the new thumbnail in GET /videos/:id", async () => {
    const upload = await seedUpload();
    await seedMetadata(upload.id, { visibility: "public" });
    const thumbnailFilename = `${upload.videoId}.webp`;

    const complete = await client
      .post(`/internal/thumbnails/${thumbnailJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ thumbnailFilename });
    expect(complete.status).toBe(200);

    const res = await client.get(`/api/v1/videos/${upload.id}`);
    expect(res.status).toBe(200);
    expect(res.body.thumbnailUrl).toBe(`/api/v1/videos/${upload.id}/thumbnail`);
  });

  test("completing an audio upload's (embedded-art) thumbnail enqueues an embed-video job", async () => {
    const upload = await seedUpload({ mediaType: "audio" });
    const thumbnailFilename = `${upload.userId ?? "_unowned"}/${upload.videoId}.webp`;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 202,
      json: async () => ({ success: true, jobs: [], skipped: [] }),
    }));

    try {
      const res = await client
        .post(`/internal/thumbnails/${thumbnailJobId(upload)}/complete`)
        .set("Authorization", `Bearer ${TOKEN}`)
        .send({ thumbnailFilename });

      expect(res.status).toBe(200);

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const [url, options] = globalThis.fetch.mock.calls[0];
      expect(String(url)).toContain("/transcode");
      const body = JSON.parse(String(options.body));
      // jobId includes a random UUID suffix (see enqueueAudioEmbedVideo) so
      // repeat enqueues for the same upload don't collide on the same
      // BullMQ jobId - only the fixed `embed-<videoId>-` prefix is stable.
      expect(body.jobs[0].jobId).toMatch(new RegExp(`^embed-${upload.videoId}-`));
      expect(body.jobs[0]).toMatchObject({
        kind: "embed",
        thumbnailFilename,
        isDefault: false,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("completing a video upload's thumbnail does not enqueue an embed-video job", async () => {
    const upload = await seedUpload({ mediaType: "video" });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 202,
      json: async () => ({ success: true, jobs: [], skipped: [] }),
    }));

    try {
      const res = await client
        .post(`/internal/thumbnails/${thumbnailJobId(upload)}/complete`)
        .set("Authorization", `Bearer ${TOKEN}`)
        .send({ thumbnailFilename: `${upload.videoId}.webp` });

      expect(res.status).toBe(200);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("skips entirely when the upload has a user-provided thumbnail (skipThumbnail)", async () => {
    const upload = await seedUpload({ skipThumbnail: true });

    const res = await client
      .post(`/internal/thumbnails/${thumbnailJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ thumbnailFilename: "late-auto-generated.webp" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("skipped_user_provided");

    const rows = await queryRows(
      "SELECT * FROM VIDEO_THUMBNAIL WHERE original_upload_id = :id",
      { id: upload.id },
    );
    expect(rows).toHaveLength(0);
  });
});

/**
 * HTTP tests for the processing → API auto-thumbnail-generation *failure*
 * callback - the signal that neither embedded cover art nor a decoded-video
 * frame grab produced anything, so an eligible audio upload falls back to
 * the bundled placeholder speaker icon (see enqueueAudioEmbedVideo).
 */
describe("POST /internal/thumbnails/:uploadUuid/failed", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("rejects missing bearer token", async () => {
    const upload = await seedUpload();

    const res = await client
      .post(`/internal/thumbnails/${thumbnailJobId(upload)}/failed`)
      .send({ error: "ffmpeg exited with code 1" });

    expect(res.status).toBe(401);
  });

  test("returns 404 for an unknown upload videoId", async () => {
    const res = await client
      .post(`/internal/thumbnails/thumbnail-000000-${randomUUID()}/failed`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ error: "ffmpeg exited with code 1" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  /**
   * Sets up a mocked fetch and posts to the /failed endpoint for `upload`,
   * returning the mock so the caller can assert whether an embed job was
   * (or wasn't) enqueued as a result.
   *
   * @param {import('sequelize').Model} upload Seeded upload.
   * @returns {Promise<jest.Mock>} The fetch mock used for the request.
   */
  async function postFailed(upload) {
    const originalFetch = globalThis.fetch;
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 202,
      json: async () => ({ success: true, jobs: [], skipped: [] }),
    }));
    globalThis.fetch = fetchMock;
    try {
      const res = await client
        .post(`/internal/thumbnails/${thumbnailJobId(upload)}/failed`)
        .set("Authorization", `Bearer ${TOKEN}`)
        .send({ error: "no video/art stream to grab a frame from" });
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
    return fetchMock;
  }

  test("falls back to the placeholder embed video for an eligible audio upload", async () => {
    const upload = await seedUpload({ mediaType: "audio" });

    const fetchMock = await postFailed(upload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/transcode");
    const body = JSON.parse(String(options.body));
    expect(body.jobs[0]).toMatchObject({
      kind: "embed",
      thumbnailFilename: "default-audio-thumbnail.png",
      isDefault: true,
    });
  });

  test("does not fall back for a video upload", async () => {
    const upload = await seedUpload({ mediaType: "video" });

    const fetchMock = await postFailed(upload);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("falls back for a mediaType:video upload that the probe confirmed has no real video stream", async () => {
    // e.g. an audio-only file someone saved with a .mp4 extension -
    // mediaType is an extension-based guess and gets this wrong, but
    // hasVideoStream (ffprobe-confirmed) is what actually gates the
    // fallback, per enqueueAudioEmbedVideo.
    const upload = await seedUpload({ mediaType: "video", hasVideoStream: false });

    const fetchMock = await postFailed(upload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.jobs[0]).toMatchObject({ kind: "embed", isDefault: true });
  });

  test("does not fall back for a mediaType:audio upload whose video-stream status is still unknown (hasVideoStream: null)", async () => {
    // Fails open, same as the equivalent probe-failure convention elsewhere -
    // null means "not yet probed / probe failed", not "confirmed no video".
    const upload = await seedUpload({ mediaType: "audio", hasVideoStream: null });

    const fetchMock = await postFailed(upload);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("does not fall back when the upload has a user-provided thumbnail (skipThumbnail)", async () => {
    const upload = await seedUpload({ mediaType: "audio", skipThumbnail: true });

    const fetchMock = await postFailed(upload);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("does not fall back when a real thumbnail was already recorded (stale/duplicate failure signal)", async () => {
    const upload = await seedUpload({ mediaType: "audio" });
    await client
      .post(`/internal/thumbnails/${thumbnailJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ thumbnailFilename: `${upload.videoId}.webp` });

    const fetchMock = await postFailed(upload);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
