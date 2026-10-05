import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import { findJobRun, upsertPendingJobRun } from "../../lib/processing-job-runs.js";
import { resetTables, seedUpload, setupSchema } from "../helpers/db.js";

const TOKEN = "test-internal-token";

/**
 * HTTP tests for the processing → API generic job-run "started" callback.
 */
describe("POST /internal/job-runs/:jobId/start", () => {
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
    const res = await client.post("/internal/job-runs/hash-abc123/start").send({});

    expect(res.status).toBe(401);
  });

  test("returns 400 when jobId is empty", async () => {
    const res = await client
      .post("/internal/job-runs/%20/start")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_job_id");
  });

  test("flips a matching row to 'processing'", async () => {
    const upload = await seedUpload();
    await upsertPendingJobRun({ originalUploadId: upload.id, jobKind: "hash", jobId: "hash-abc123" });

    const res = await client
      .post("/internal/job-runs/hash-abc123/start")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const row = await findJobRun(upload.id, "hash");
    expect(row.status).toBe("processing");
  });

  test("is a harmless no-op when jobId matches no row", async () => {
    const res = await client
      .post("/internal/job-runs/no-such-job/start")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });
});
