import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import { resetTables, seedUser, seedUserApiKey, setupSchema } from "../helpers/db.js";
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
        thumbnail: { waiting: 0, active: 1, delayed: 0 },
        normalize: { waiting: 0, active: 0, delayed: 0 },
        rendition: { waiting: 1, active: 1, delayed: 0 },
        embed: { waiting: 0, active: 0, delayed: 0 },
        hash: { waiting: 0, active: 0, delayed: 1 },
      },
      total: 4,
    });
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
    expect(res.body.counts.rendition).toEqual({ waiting: 0, active: 0, delayed: 0 });
  });

  test("returns 502 when the processing service is unreachable", async () => {
    const rawKey = "jt_test_admin_jobs_down";
    await seedUserWithRoleAndKey("admin", rawKey);
    globalThis.fetch = jest.fn(async () => {
      throw new Error("network down");
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
    expect(res.body).toEqual({ items, total: 12, page: 2, limit: 3 });
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
