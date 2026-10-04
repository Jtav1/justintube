import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import { OriginalUpload } from "../../lib/models/index.js";
import { resetTables, seedUpload, setupSchema } from "../helpers/db.js";

const TOKEN = "test-internal-token";

/**
 * Builds an `hls-<videoId>-<uuid>` BullMQ jobId, matching what
 * `routes/uploads.js` actually enqueues "Best" quality HLS jobs with, for
 * use as the `:jobId` route param in these callback tests.
 *
 * @param {import('sequelize').Model} upload Seeded upload.
 * @returns {string} A well-formed hls jobId for `upload`.
 */
function hlsJobId(upload) {
  return `hls-${upload.videoId}-${randomUUID()}`;
}

/**
 * HTTP tests for the processing → API "Best" quality HLS packaging callback.
 */
describe("POST /internal/hls/:jobId/complete", () => {
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
      .post(`/internal/hls/${hlsJobId(upload)}/complete`)
      .send({ playlistPath: `transcoded/${upload.videoId}.hls/variant.m3u8` });

    expect(res.status).toBe(401);
  });

  test("returns 400 when playlistPath is missing", async () => {
    const upload = await seedUpload();

    const res = await client
      .post(`/internal/hls/${hlsJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("returns 400 when the jobId isn't a well-formed hls-<videoId>-<uuid>", async () => {
    const res = await client
      .post("/internal/hls/not-an-hls-job/complete")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ playlistPath: "transcoded/whatever/variant.m3u8" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_uuid");
  });

  test("returns 404 for an unknown upload videoId", async () => {
    const res = await client
      .post(`/internal/hls/hls-000000-${randomUUID()}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ playlistPath: "transcoded/whatever/variant.m3u8" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("records the playlist path on the upload", async () => {
    const upload = await seedUpload();
    const playlistPath = `transcoded/${upload.videoId}.hls/variant.m3u8`;

    const res = await client
      .post(`/internal/hls/${hlsJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ playlistPath, bitRateBps: 2_500_000 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, videoId: upload.videoId, status: "complete" });

    const reloaded = await OriginalUpload.findByPk(upload.id);
    expect(reloaded.hlsPlaylistStoragePath).toBe(playlistPath);
  });

  test("overwrites a previously recorded playlist path on a re-run", async () => {
    const upload = await seedUpload();
    const firstPath = `transcoded/${upload.videoId}.hls-old/variant.m3u8`;
    const secondPath = `transcoded/${upload.videoId}.hls-new/variant.m3u8`;

    await client
      .post(`/internal/hls/${hlsJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ playlistPath: firstPath });

    const res = await client
      .post(`/internal/hls/${hlsJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ playlistPath: secondPath });

    expect(res.status).toBe(200);
    const reloaded = await OriginalUpload.findByPk(upload.id);
    expect(reloaded.hlsPlaylistStoragePath).toBe(secondPath);
  });
});

describe("POST /internal/hls/:jobId/fail", () => {
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

    const res = await client.post(`/internal/hls/${hlsJobId(upload)}/fail`).send({});

    expect(res.status).toBe(401);
  });

  test("returns 400 when the jobId isn't a well-formed hls-<videoId>-<uuid>", async () => {
    const res = await client
      .post("/internal/hls/not-an-hls-job/fail")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_uuid");
  });

  test("returns 404 for an unknown upload videoId", async () => {
    const res = await client
      .post(`/internal/hls/hls-000000-${randomUUID()}/fail`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ error: "ffmpeg exited with code 1" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("records the failure without touching hlsPlaylistStoragePath", async () => {
    const upload = await seedUpload();

    const res = await client
      .post(`/internal/hls/${hlsJobId(upload)}/fail`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ error: "ffmpeg exited with code 1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, videoId: upload.videoId });

    const reloaded = await OriginalUpload.findByPk(upload.id);
    expect(reloaded.hlsPlaylistStoragePath).toBeNull();
  });
});
