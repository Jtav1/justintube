import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import { OriginalUpload } from "../../lib/models/index.js";
import { resetTables, seedUpload, setupSchema } from "../helpers/db.js";

const TOKEN = "test-internal-token";

/**
 * Builds a `storyboard-<videoId>-<uuid>` BullMQ jobId, matching what
 * `routes/uploads.js` actually enqueues storyboard jobs with, for use as the
 * `:jobId` route param in these callback tests.
 *
 * @param {import('sequelize').Model} upload Seeded upload.
 * @returns {string} A well-formed storyboard jobId for `upload`.
 */
function storyboardJobId(upload) {
  return `storyboard-${upload.videoId}-${randomUUID()}`;
}

/**
 * HTTP tests for the processing → API storyboard sprite-sheet/VTT callback.
 */
describe("POST /internal/storyboard/:jobId/complete", () => {
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
      .post(`/internal/storyboard/${storyboardJobId(upload)}/complete`)
      .send({ vttPath: `storyboards/${upload.videoId}.storyboard/storyboard.vtt` });

    expect(res.status).toBe(401);
  });

  test("returns 400 when vttPath is missing", async () => {
    const upload = await seedUpload();

    const res = await client
      .post(`/internal/storyboard/${storyboardJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("returns 400 when the jobId isn't a well-formed storyboard-<videoId>-<uuid>", async () => {
    const res = await client
      .post("/internal/storyboard/not-a-storyboard-job/complete")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ vttPath: "storyboards/whatever/storyboard.vtt" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_uuid");
  });

  test("returns 404 for an unknown upload videoId", async () => {
    const res = await client
      .post(`/internal/storyboard/storyboard-000000-${randomUUID()}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ vttPath: "storyboards/whatever/storyboard.vtt" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("records the VTT path on the upload", async () => {
    const upload = await seedUpload();
    const vttPath = `storyboards/${upload.videoId}.storyboard/storyboard.vtt`;

    const res = await client
      .post(`/internal/storyboard/${storyboardJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ vttPath });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, videoId: upload.videoId, status: "complete" });

    const reloaded = await OriginalUpload.findByPk(upload.id);
    expect(reloaded.storyboardVttStoragePath).toBe(vttPath);
  });

  test("overwrites a previously recorded VTT path on a re-run", async () => {
    const upload = await seedUpload();
    const firstPath = `storyboards/${upload.videoId}.storyboard-old/storyboard.vtt`;
    const secondPath = `storyboards/${upload.videoId}.storyboard-new/storyboard.vtt`;

    await client
      .post(`/internal/storyboard/${storyboardJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ vttPath: firstPath });

    const res = await client
      .post(`/internal/storyboard/${storyboardJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ vttPath: secondPath });

    expect(res.status).toBe(200);
    const reloaded = await OriginalUpload.findByPk(upload.id);
    expect(reloaded.storyboardVttStoragePath).toBe(secondPath);
  });
});

describe("POST /internal/storyboard/:jobId/fail", () => {
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

    const res = await client.post(`/internal/storyboard/${storyboardJobId(upload)}/fail`).send({});

    expect(res.status).toBe(401);
  });

  test("returns 400 when the jobId isn't a well-formed storyboard-<videoId>-<uuid>", async () => {
    const res = await client
      .post("/internal/storyboard/not-a-storyboard-job/fail")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_uuid");
  });

  test("returns 404 for an unknown upload videoId", async () => {
    const res = await client
      .post(`/internal/storyboard/storyboard-000000-${randomUUID()}/fail`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ error: "ffmpeg exited with code 1" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("records the failure without touching storyboardVttStoragePath", async () => {
    const upload = await seedUpload();

    const res = await client
      .post(`/internal/storyboard/${storyboardJobId(upload)}/fail`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ error: "ffmpeg exited with code 1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, videoId: upload.videoId });

    const reloaded = await OriginalUpload.findByPk(upload.id);
    expect(reloaded.storyboardVttStoragePath).toBeNull();
  });
});
