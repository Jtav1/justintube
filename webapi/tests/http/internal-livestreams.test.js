import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import {
  queryRows,
  resetTables,
  seedStreamKey,
  seedUser,
  setupSchema,
} from "../helpers/db.js";

const TOKEN = "test-internal-token";

/**
 * HTTP tests for the RTMP ingest server → API livestream lifecycle callbacks.
 */
describe("/internal/livestreams", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("authorize rejects missing bearer token", async () => {
    const res = await client
      .post("/internal/livestreams/authorize")
      .send({ streamKey: "sk_whatever" });
    expect(res.status).toBe(401);
  });

  test("authorize rejects an unknown stream key", async () => {
    const res = await client
      .post("/internal/livestreams/authorize")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ streamKey: "sk_does_not_exist" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("authorize creates a livestream row on first publish and updates lastUsedAt", async () => {
    const user = await seedUser({ username: "obs-user", email: "obs@example.com" });
    await seedStreamKey(user.id, "sk_valid_raw_key");

    const res = await client
      .post("/internal/livestreams/authorize")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ streamKey: "sk_valid_raw_key" });

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(user.id);
    expect(typeof res.body.livestreamId).toBe("number");

    const rows = await queryRows("SELECT status FROM LIVESTREAMS WHERE user_id = :userId", {
      userId: user.id,
    });
    expect(rows[0].status).toBe("offline");

    const keys = await queryRows("SELECT last_used_at FROM STREAM_KEYS WHERE user_id = :userId", {
      userId: user.id,
    });
    expect(keys[0].last_used_at).not.toBeNull();
  });

  test("start flips status to live and records startedAt", async () => {
    const user = await seedUser({ username: "start-user", email: "start@example.com" });
    await seedStreamKey(user.id, "sk_start_key");
    const authorize = await client
      .post("/internal/livestreams/authorize")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ streamKey: "sk_start_key" });

    const res = await client
      .post(`/internal/livestreams/${authorize.body.livestreamId}/start`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("live");
    expect(res.body.startedAt).toBeTruthy();
  });

  test("stop flips status to offline and resets viewer count", async () => {
    const user = await seedUser({ username: "stop-user", email: "stop@example.com" });
    await seedStreamKey(user.id, "sk_stop_key");
    const authorize = await client
      .post("/internal/livestreams/authorize")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ streamKey: "sk_stop_key" });
    await client
      .post(`/internal/livestreams/${authorize.body.livestreamId}/start`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send();

    const res = await client
      .post(`/internal/livestreams/${authorize.body.livestreamId}/stop`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("offline");

    const rows = await queryRows("SELECT viewer_count FROM LIVESTREAMS WHERE id = :id", {
      id: authorize.body.livestreamId,
    });
    expect(Number(rows[0].viewer_count)).toBe(0);
  });

  test("start returns 404 for an unknown livestream id", async () => {
    const res = await client
      .post("/internal/livestreams/999999/start")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send();
    expect(res.status).toBe(404);
  });
});

/**
 * HTTP tests for MediaMTX's authHTTPAddress webhook. Unlike the other
 * internal routes, this one is gated by a query-string token (MediaMTX
 * can't send an Authorization header) and speaks MediaMTX's fixed webhook
 * body shape `{ action, path }` rather than `{ streamKey }`.
 */
describe("/internal/livestreams/mediamtx-auth", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("rejects a missing/wrong token", async () => {
    const res = await client
      .post("/internal/livestreams/mediamtx-auth")
      .send({ action: "publish", path: "live/sk_whatever" });
    expect(res.status).toBe(401);
  });

  test("rejects non-publish actions", async () => {
    const res = await client
      .post(`/internal/livestreams/mediamtx-auth?token=${TOKEN}`)
      .send({ action: "read", path: "live/sk_whatever" });
    expect(res.status).toBe(403);
  });

  test("rejects an unknown stream key", async () => {
    const res = await client
      .post(`/internal/livestreams/mediamtx-auth?token=${TOKEN}`)
      .send({ action: "publish", path: "live/sk_does_not_exist" });
    expect(res.status).toBe(403);
  });

  test("accepts a valid stream key embedded in the publish path", async () => {
    const user = await seedUser({ username: "mtx-user", email: "mtx@example.com" });
    await seedStreamKey(user.id, "sk_mediamtx_valid_key");

    const res = await client
      .post(`/internal/livestreams/mediamtx-auth?token=${TOKEN}`)
      .send({ action: "publish", path: "live/sk_mediamtx_valid_key" });
    expect(res.status).toBe(200);

    const keys = await queryRows("SELECT last_used_at FROM STREAM_KEYS WHERE user_id = :userId", {
      userId: user.id,
    });
    expect(keys[0].last_used_at).not.toBeNull();
  });

  test("rejects a revoked stream key", async () => {
    const user = await seedUser({ username: "mtx-revoked", email: "mtx-revoked@example.com" });
    await seedStreamKey(user.id, "sk_mediamtx_revoked_key", { revokedAt: new Date() });

    const res = await client
      .post(`/internal/livestreams/mediamtx-auth?token=${TOKEN}`)
      .send({ action: "publish", path: "live/sk_mediamtx_revoked_key" });
    expect(res.status).toBe(403);
  });
});
