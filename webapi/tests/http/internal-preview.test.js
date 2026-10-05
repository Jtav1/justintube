import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import { OriginalUpload } from "../../lib/models/index.js";
import { resetTables, seedUpload, setupSchema } from "../helpers/db.js";

const TOKEN = "test-internal-token";

/**
 * Builds a `preview-<videoId>-<uuid>` BullMQ jobId, matching what
 * `routes/uploads.js` actually enqueues preview-clip jobs with, for use as
 * the `:jobId` route param in these callback tests.
 *
 * @param {import('sequelize').Model} upload Seeded upload.
 * @returns {string} A well-formed preview jobId for `upload`.
 */
function previewJobId(upload) {
  return `preview-${upload.videoId}-${randomUUID()}`;
}

/**
 * HTTP tests for the processing → API hover-preview clip callback.
 */
describe("POST /internal/preview/:jobId/complete", () => {
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
      .post(`/internal/preview/${previewJobId(upload)}/complete`)
      .send({ storagePath: `transcoded/${randomUUID()}-preview.mp4` });

    expect(res.status).toBe(401);
  });

  test("returns 400 when storagePath is missing", async () => {
    const upload = await seedUpload();

    const res = await client
      .post(`/internal/preview/${previewJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("returns 400 when the jobId isn't a well-formed preview-<videoId>-<uuid>", async () => {
    const res = await client
      .post("/internal/preview/not-a-preview-job/complete")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ storagePath: "transcoded/whatever-preview.mp4" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_uuid");
  });

  test("returns 404 for an unknown upload videoId", async () => {
    const res = await client
      .post(`/internal/preview/preview-000000-${randomUUID()}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ storagePath: "transcoded/whatever-preview.mp4" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("records the storage path and dimensions on the upload", async () => {
    const upload = await seedUpload();
    const storagePath = `transcoded/${randomUUID()}-preview.mp4`;

    const res = await client
      .post(`/internal/preview/${previewJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ storagePath, videoWidth: 480, videoHeight: 270 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, videoId: upload.videoId, status: "complete" });

    const reloaded = await OriginalUpload.findByPk(upload.id);
    expect(reloaded.previewClipStoragePath).toBe(storagePath);
    expect(reloaded.previewClipWidth).toBe(480);
    expect(reloaded.previewClipHeight).toBe(270);
  });

  test("records a null width/height when omitted", async () => {
    const upload = await seedUpload();
    const storagePath = `transcoded/${randomUUID()}-preview.mp4`;

    const res = await client
      .post(`/internal/preview/${previewJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ storagePath });

    expect(res.status).toBe(200);
    const reloaded = await OriginalUpload.findByPk(upload.id);
    expect(reloaded.previewClipStoragePath).toBe(storagePath);
    expect(reloaded.previewClipWidth).toBeNull();
    expect(reloaded.previewClipHeight).toBeNull();
  });

  test("overwrites a previously recorded storage path on a re-run", async () => {
    const upload = await seedUpload();
    const firstPath = `transcoded/${randomUUID()}-preview-old.mp4`;
    const secondPath = `transcoded/${randomUUID()}-preview-new.mp4`;

    await client
      .post(`/internal/preview/${previewJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ storagePath: firstPath });

    const res = await client
      .post(`/internal/preview/${previewJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ storagePath: secondPath });

    expect(res.status).toBe(200);
    const reloaded = await OriginalUpload.findByPk(upload.id);
    expect(reloaded.previewClipStoragePath).toBe(secondPath);
  });
});

describe("POST /internal/preview/:jobId/fail", () => {
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

    const res = await client.post(`/internal/preview/${previewJobId(upload)}/fail`).send({});

    expect(res.status).toBe(401);
  });

  test("returns 400 when the jobId isn't a well-formed preview-<videoId>-<uuid>", async () => {
    const res = await client
      .post("/internal/preview/not-a-preview-job/fail")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_uuid");
  });

  test("returns 404 for an unknown upload videoId", async () => {
    const res = await client
      .post(`/internal/preview/preview-000000-${randomUUID()}/fail`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ error: "ffmpeg exited with code 1" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("records the failure without touching previewClipStoragePath", async () => {
    const upload = await seedUpload();

    const res = await client
      .post(`/internal/preview/${previewJobId(upload)}/fail`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ error: "ffmpeg exited with code 1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, videoId: upload.videoId });

    const reloaded = await OriginalUpload.findByPk(upload.id);
    expect(reloaded.previewClipStoragePath).toBeNull();
  });
});
