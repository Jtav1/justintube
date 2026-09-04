import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedFileVersion,
  seedUpload,
  seedUser,
  seedUserApiKey,
  setupSchema,
} from "../helpers/db.js";
import { Role } from "../../lib/models/index.js";

/**
 * Seeds a user with the given role name and an API key for Bearer auth.
 *
 * @param {string} roleName Role name (`admin`, `moderator`, `viewer`, …).
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
 * Builds a `fetch` mock answering a given path with a fixed JSON body.
 *
 * @param {(url: string) => {status: number, body: object}} respond Maps a
 *   request URL to a status/body pair.
 * @returns {jest.Mock} Fetch mock.
 */
function fetchMockFor(respond) {
  return jest.fn(async (url) => {
    const { status, body } = respond(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  });
}

describe("GET /api/v1/admin/jobs/queue", () => {
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

  test("rejects an unauthenticated request", async () => {
    const res = await client.get("/api/v1/admin/jobs/queue");
    expect(res.status).toBe(401);
  });

  test("rejects a non-admin", async () => {
    const rawKey = "jt_test_admin_jobs_viewer";
    await seedUserWithRoleAndKey("viewer", rawKey);

    const res = await client
      .get("/api/v1/admin/jobs/queue")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("buckets non-terminal jobs by kind and state, seeding every known kind", async () => {
    const rawKey = "jt_test_admin_jobs_queue";
    await seedUserWithRoleAndKey("admin", rawKey);
    globalThis.fetch = fetchMockFor(() => ({
      status: 200,
      body: {
        success: true,
        jobs: [
          { jobId: "r1", kind: "rendition", name: "ffmpeg-transcode", state: "waiting", truncated: false },
          { jobId: "r2", kind: "rendition", name: "ffmpeg-transcode", state: "active", truncated: false },
          { jobId: "t1", kind: "thumbnail", name: "ffmpeg-thumbnail", state: "active", truncated: false },
          { jobId: "h1", kind: "hash", name: "ffmpeg-hash", state: "delayed", truncated: false },
        ],
      },
    }));

    const res = await client
      .get("/api/v1/admin/jobs/queue")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      counts: {
        thumbnail: { waiting: 0, prioritized: 0, active: 1, delayed: 0 },
        normalize: { waiting: 0, prioritized: 0, active: 0, delayed: 0 },
        rendition: { waiting: 1, prioritized: 0, active: 1, delayed: 0 },
        embed: { waiting: 0, prioritized: 0, active: 0, delayed: 0 },
        hash: { waiting: 0, prioritized: 0, active: 0, delayed: 1 },
        subtitle: { waiting: 0, prioritized: 0, active: 0, delayed: 0 },
      },
      total: 4,
      healthy: true,
    });
  });

  test("buckets a prioritized job (the common case - every job is enqueued with a priority)", async () => {
    const rawKey = "jt_test_admin_jobs_prioritized";
    await seedUserWithRoleAndKey("admin", rawKey);
    globalThis.fetch = fetchMockFor(() => ({
      status: 200,
      body: {
        success: true,
        jobs: [
          { jobId: "s1", kind: "subtitle", name: "ffmpeg-subtitle", state: "prioritized", truncated: false },
        ],
      },
    }));

    const res = await client
      .get("/api/v1/admin/jobs/queue")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
    expect(res.body.counts.subtitle).toEqual({ waiting: 0, prioritized: 1, active: 0, delayed: 0 });
    expect(res.body.total).toBe(1);
  });

  test("returns an all-zero summary when the queue is empty", async () => {
    const rawKey = "jt_test_admin_jobs_empty";
    await seedUserWithRoleAndKey("admin", rawKey);
    globalThis.fetch = fetchMockFor(() => ({ status: 200, body: { success: true, jobs: [] } }));

    const res = await client
      .get("/api/v1/admin/jobs/queue")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.healthy).toBe(true);
    expect(res.body.counts.rendition).toEqual({ waiting: 0, prioritized: 0, active: 0, delayed: 0 });
  });

  test("returns healthy:false with an all-zero queue when processing is unreachable", async () => {
    const rawKey = "jt_test_admin_jobs_down";
    await seedUserWithRoleAndKey("admin", rawKey);
    globalThis.fetch = jest.fn(async () => {
      throw new Error("network down");
    });

    const res = await client
      .get("/api/v1/admin/jobs/queue")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
    expect(res.body.healthy).toBe(false);
    expect(res.body.total).toBe(0);
    expect(res.body.counts.rendition).toEqual({ waiting: 0, prioritized: 0, active: 0, delayed: 0 });
  });

  test("returns 502 when the queue-jobs call fails but processing still reports healthy", async () => {
    const rawKey = "jt_test_admin_jobs_queue_error";
    await seedUserWithRoleAndKey("admin", rawKey);
    globalThis.fetch = jest.fn(async (url) => {
      if (String(url).endsWith("/health")) {
        return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
      }
      return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
    });

    const res = await client
      .get("/api/v1/admin/jobs/queue")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("processing_unavailable");
  });
});

describe("GET /api/v1/admin/jobs/history", () => {
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

  test("rejects an unauthenticated request", async () => {
    const res = await client.get("/api/v1/admin/jobs/history");
    expect(res.status).toBe(401);
  });

  test("rejects a non-admin", async () => {
    const rawKey = "jt_test_admin_jobs_history_viewer";
    await seedUserWithRoleAndKey("viewer", rawKey);

    const res = await client
      .get("/api/v1/admin/jobs/history")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(403);
  });

  test("defaults to limit=5 and forwards page/limit to processing", async () => {
    const rawKey = "jt_test_admin_jobs_history_default";
    await seedUserWithRoleAndKey("admin", rawKey);
    let requestedUrl = null;
    globalThis.fetch = fetchMockFor((url) => {
      requestedUrl = url;
      return { status: 200, body: { success: true, items: [], total: 0, page: 1, limit: 5 } };
    });

    const res = await client
      .get("/api/v1/admin/jobs/history")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], total: 0, page: 1, limit: 5 });
    expect(requestedUrl).toContain("limit=5");
    expect(requestedUrl).toContain("page=1");
  });

  test("passes through explicit page/limit and the returned items", async () => {
    const rawKey = "jt_test_admin_jobs_history_paged";
    await seedUserWithRoleAndKey("admin", rawKey);
    const items = [
      { jobId: "c1", kind: "rendition", name: "ffmpeg-transcode", state: "completed", finishedOn: 5000, processedOn: 4000, failedReason: null },
    ];
    globalThis.fetch = fetchMockFor(() => ({
      status: 200,
      body: { success: true, items, total: 12, page: 2, limit: 3 },
    }));

    const res = await client
      .get("/api/v1/admin/jobs/history?page=2&limit=3")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
    // "c1" doesn't match any seeded FileVersion, so the rendition item's
    // upload can't be resolved - see the dedicated resolution tests below
    // for the cases where it can.
    expect(res.body).toEqual({
      items: [{ ...items[0], uploadId: null, videoId: null }],
      total: 12,
      page: 2,
      limit: 3,
    });
  });

  test("resolves uploadId/videoId for job kinds that embed videoId directly in the jobId", async () => {
    const rawKey = "jt_test_admin_jobs_history_direct";
    await seedUserWithRoleAndKey("admin", rawKey);
    const upload = await seedUpload();
    const items = [
      {
        jobId: `thumbnail-${upload.videoId}-11111111-1111-1111-1111-111111111111`,
        kind: "thumbnail",
        name: "ffmpeg-thumbnail",
        state: "completed",
        finishedOn: 1000,
        processedOn: 900,
        failedReason: null,
      },
      {
        jobId: `subtitle-${upload.videoId}-22222222-2222-2222-2222-222222222222`,
        kind: "subtitle",
        name: "ffmpeg-subtitle",
        state: "completed",
        finishedOn: 2000,
        processedOn: 1900,
        failedReason: null,
      },
      {
        jobId: `normalize-${upload.videoId}`,
        kind: "normalize",
        name: "ffmpeg-normalize",
        state: "completed",
        finishedOn: 3000,
        processedOn: 2900,
        failedReason: null,
      },
      {
        jobId: `hash-${upload.videoId}`,
        kind: "hash",
        name: "ffmpeg-hash",
        state: "completed",
        finishedOn: 4000,
        processedOn: 3900,
        failedReason: null,
      },
      {
        jobId: `nope-${upload.videoId}`,
        kind: "unknown_kind",
        name: "mystery",
        state: "completed",
        finishedOn: 500,
        processedOn: 400,
        failedReason: null,
      },
    ];
    globalThis.fetch = fetchMockFor(() => ({
      status: 200,
      body: { success: true, items, total: items.length, page: 1, limit: 5 },
    }));

    const res = await client
      .get("/api/v1/admin/jobs/history")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
    const byKind = Object.fromEntries(res.body.items.map((item) => [item.kind, item]));
    expect(byKind.thumbnail).toMatchObject({ uploadId: upload.id, videoId: upload.videoId });
    expect(byKind.subtitle).toMatchObject({ uploadId: upload.id, videoId: upload.videoId });
    expect(byKind.normalize).toMatchObject({ uploadId: upload.id, videoId: upload.videoId });
    expect(byKind.hash).toMatchObject({ uploadId: upload.id, videoId: upload.videoId });
    expect(byKind.unknown_kind).toMatchObject({ uploadId: null, videoId: null });
  });

  test("resolves uploadId/videoId for a rendition job via its FileVersion.uuidName", async () => {
    const rawKey = "jt_test_admin_jobs_history_rendition";
    await seedUserWithRoleAndKey("admin", rawKey);
    const upload = await seedUpload();
    const version = await seedFileVersion(upload.id);
    const items = [
      {
        jobId: version.uuidName,
        kind: "rendition",
        name: "ffmpeg-transcode",
        state: "completed",
        finishedOn: 1000,
        processedOn: 900,
        failedReason: null,
      },
      {
        jobId: "00000000-0000-0000-0000-000000000000",
        kind: "rendition",
        name: "ffmpeg-transcode",
        state: "completed",
        finishedOn: 2000,
        processedOn: 1900,
        failedReason: null,
      },
    ];
    globalThis.fetch = fetchMockFor(() => ({
      status: 200,
      body: { success: true, items, total: items.length, page: 1, limit: 5 },
    }));

    const res = await client
      .get("/api/v1/admin/jobs/history")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({ uploadId: upload.id, videoId: upload.videoId });
    expect(res.body.items[1]).toMatchObject({ uploadId: null, videoId: null });
  });

  test("returns 400 invalid_query for a non-positive page", async () => {
    const rawKey = "jt_test_admin_jobs_history_badpage";
    await seedUserWithRoleAndKey("admin", rawKey);

    const res = await client
      .get("/api/v1/admin/jobs/history?page=0")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  test("returns 502 when the processing service is unreachable", async () => {
    const rawKey = "jt_test_admin_jobs_history_down";
    await seedUserWithRoleAndKey("admin", rawKey);
    globalThis.fetch = jest.fn(async () => {
      throw new Error("network down");
    });

    const res = await client
      .get("/api/v1/admin/jobs/history")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("processing_unavailable");
  });
});
