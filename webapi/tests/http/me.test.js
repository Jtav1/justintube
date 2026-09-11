import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { User } from "../../lib/models/index.js";
import { createTestAgent, createTestClient } from "../helpers/app.js";
import {
  queryRows,
  resetTables,
  seedMetadata,
  seedUpload,
  seedUser,
  seedUserApiKey,
  seedUserViewHistory,
  seedVideoAccess,
  seedVideoLike,
  seedVideoThumbnail,
  setupSchema,
} from "../helpers/db.js";

/**
 * Fetches a CSRF token using a persistent agent so the session cookie is kept.
 *
 * @param {import('supertest').SuperAgentTest} agent Supertest agent with cookies.
 * @returns {Promise<string>} CSRF token string.
 */
async function fetchCsrf(agent) {
  const res = await agent.get("/api/v1/auth/csrf");
  expect(res.status).toBe(200);
  expect(typeof res.body.csrfToken).toBe("string");
  return res.body.csrfToken;
}

/**
 * Registers a new viewer account via the auth API and returns the agent session.
 *
 * @param {import('supertest').SuperAgentTest} agent Supertest agent with cookies.
 * @param {{ username: string, email: string, password?: string }} account Account fields.
 * @returns {Promise<{ csrfToken: string, user: object }>} Session CSRF and user payload.
 */
async function registerSession(agent, account) {
  const csrf = await fetchCsrf(agent);
  const res = await agent
    .post("/api/v1/auth/register")
    .set("X-CSRF-Token", csrf)
    .send({
      username: account.username,
      email: account.email,
      password: account.password || "password123",
      displayName: account.username,
    });
  expect(res.status).toBe(201);
  return { csrfToken: res.body.csrfToken, user: res.body.user };
}

describe("me / account settings routes", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("unauthenticated GET /me/settings returns 401", async () => {
    const client = createTestClient();
    const res = await client.get("/api/v1/me/settings");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("unauthenticated PATCH /me without a CSRF token returns 403", async () => {
    // csrfProtection runs before requireAuth on this router (same as the
    // notification-preferences router), so an unauthenticated mutating
    // request with no session/CSRF token fails CSRF first.
    const client = createTestClient();
    const res = await client.patch("/api/v1/me").send({ bio: "hi" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("csrf_invalid");
  });

  test("GET /me/settings returns account metadata without password fields", async () => {
    const agent = createTestAgent();
    await registerSession(agent, {
      username: "settings_view",
      email: "settings_view@example.com",
    });

    const res = await agent.get("/api/v1/me/settings");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      username: "settings_view",
      email: "settings_view@example.com",
      uploader: false,
    });
    expect(res.body).not.toHaveProperty("passwordHash");
    expect(res.body).toHaveProperty("passwordExpired");
    expect(res.body).toHaveProperty("emailVerifiedAt");
    expect(res.body).toHaveProperty("role");
  });

  test("PATCH /me without CSRF token returns 403", async () => {
    const agent = createTestAgent();
    await registerSession(agent, {
      username: "settings_nocsrf",
      email: "settings_nocsrf@example.com",
    });

    const res = await agent.patch("/api/v1/me").send({ bio: "hi" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("csrf_invalid");
  });

  test("PATCH /me updates displayName, bio, and email; reflected on next GET", async () => {
    const agent = createTestAgent();
    await registerSession(agent, {
      username: "settings_update",
      email: "settings_update@example.com",
    });
    const csrfToken = await fetchCsrf(agent);

    const patch = await agent
      .patch("/api/v1/me")
      .set("X-CSRF-Token", csrfToken)
      .send({
        displayName: "New Name",
        bio: "New bio",
        email: "settings_update_new@example.com",
      });

    expect(patch.status).toBe(200);
    expect(patch.body.displayName).toBe("New Name");
    expect(patch.body.bio).toBe("New bio");
    expect(patch.body.email).toBe("settings_update_new@example.com");

    const get = await agent.get("/api/v1/me/settings");
    expect(get.status).toBe(200);
    expect(get.body.displayName).toBe("New Name");
    expect(get.body.bio).toBe("New bio");
    expect(get.body.email).toBe("settings_update_new@example.com");
  });

  test("PATCH /me changing email resets emailVerified and emailVerifiedAt", async () => {
    const agent = createTestAgent();
    await registerSession(agent, {
      username: "settings_verify_reset",
      email: "settings_verify_reset@example.com",
    });
    const csrfToken = await fetchCsrf(agent);

    const patch = await agent
      .patch("/api/v1/me")
      .set("X-CSRF-Token", csrfToken)
      .send({ email: "settings_verify_reset_new@example.com" });

    expect(patch.status).toBe(200);
    expect(patch.body.emailVerified).toBe(false);
    expect(patch.body.emailVerifiedAt).toBeNull();
  });

  test.each([
    ["id", 999],
    ["passwordHash", "hack"],
    ["passwordExpired", true],
    ["emailVerified", true],
    ["emailVerifiedAt", new Date().toISOString()],
    ["uploader", true],
    ["roleId", 999],
    ["role", "admin"],
  ])("PATCH /me rejects attempts to set %s", async (field, value) => {
    const agent = createTestAgent();
    await registerSession(agent, {
      username: "settings_forbidden",
      email: "settings_forbidden@example.com",
    });
    const csrfToken = await fetchCsrf(agent);

    const before = await agent.get("/api/v1/me/settings");
    const originalValue = before.body[field];

    const res = await agent
      .patch("/api/v1/me")
      .set("X-CSRF-Token", csrfToken)
      .send({ [field]: value });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");

    const get = await agent.get("/api/v1/me/settings");
    expect(get.body[field]).toEqual(originalValue);
  });

  test("PATCH /me with an email already used by another account returns 409", async () => {
    await seedUser({
      username: "settings_taken",
      email: "settings_taken@example.com",
    });

    const agent = createTestAgent();
    await registerSession(agent, {
      username: "settings_conflict",
      email: "settings_conflict@example.com",
    });
    const csrfToken = await fetchCsrf(agent);

    const res = await agent
      .patch("/api/v1/me")
      .set("X-CSRF-Token", csrfToken)
      .send({ email: "settings_taken@example.com" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("conflict");
  });

  test("PATCH /me rejects a malformed email", async () => {
    const user = await seedUser({
      username: "settings_bad_email",
      email: "settings_bad_email@example.com",
    });
    await seedUserApiKey(user.id, "jt_test_settings_bad_email_key");

    const res = await createTestClient()
      .patch("/api/v1/me")
      .set("Authorization", "Bearer jt_test_settings_bad_email_key")
      .send({ email: "not-an-email" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("PATCH /me updates username; reflected on next GET", async () => {
    const user = await seedUser({
      username: "settings_username_before",
      email: "settings_username_before@example.com",
    });
    await seedUserApiKey(user.id, "jt_test_settings_username_key");

    const client = createTestClient();
    const patch = await client
      .patch("/api/v1/me")
      .set("Authorization", "Bearer jt_test_settings_username_key")
      .send({ username: "settings_username_after" });

    expect(patch.status).toBe(200);
    expect(patch.body.username).toBe("settings_username_after");

    const get = await client
      .get("/api/v1/me/settings")
      .set("Authorization", "Bearer jt_test_settings_username_key");
    expect(get.status).toBe(200);
    expect(get.body.username).toBe("settings_username_after");
  });

  test("PATCH /me with a username already used by another account returns 409", async () => {
    await seedUser({
      username: "settings_username_taken",
      email: "settings_username_taken@example.com",
    });
    const user = await seedUser({
      username: "settings_username_conflict",
      email: "settings_username_conflict@example.com",
    });
    await seedUserApiKey(user.id, "jt_test_settings_username_conflict_key");

    const res = await createTestClient()
      .patch("/api/v1/me")
      .set("Authorization", "Bearer jt_test_settings_username_conflict_key")
      .send({ username: "settings_username_taken" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("conflict");
  });

  test("PATCH /me rejects an empty username", async () => {
    const user = await seedUser({
      username: "settings_empty_username",
      email: "settings_empty_username@example.com",
    });
    await seedUserApiKey(user.id, "jt_test_settings_empty_username_key");

    const res = await createTestClient()
      .patch("/api/v1/me")
      .set("Authorization", "Bearer jt_test_settings_empty_username_key")
      .send({ username: "   " });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("one user's PATCH does not affect another user's account", async () => {
    const bob = await seedUser({
      username: "bob_settings",
      email: "bob_settings@example.com",
      displayName: "Bob",
    });

    const agent = createTestAgent();
    await registerSession(agent, {
      username: "alice_settings",
      email: "alice_settings@example.com",
    });
    const csrfToken = await fetchCsrf(agent);

    const patch = await agent
      .patch("/api/v1/me")
      .set("X-CSRF-Token", csrfToken)
      .send({ displayName: "Alice Updated" });
    expect(patch.status).toBe(200);

    const reloadedBob = await User.findByPk(bob.id);
    expect(reloadedBob.displayName).toBe("Bob");
  });
});

describe("me / videos and likes routes", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("unauthenticated GET /me/videos returns 401", async () => {
    const client = createTestClient();
    const res = await client.get("/api/v1/me/videos");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("unauthenticated GET /me/likes returns 401", async () => {
    const client = createTestClient();
    const res = await client.get("/api/v1/me/likes");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("GET /me/videos returns only my uploads, all visibilities, newest first", async () => {
    const agent = createTestAgent();
    const { user } = await registerSession(agent, {
      username: "myvideos_owner",
      email: "myvideos_owner@example.com",
    });

    const other = await seedUser({ username: "myvideos_other", email: "myvideos_other@example.com" });
    const otherUpload = await seedUpload({ userId: other.id });
    await seedMetadata(otherUpload.id, { title: "Not mine" });

    const older = await seedUpload({ userId: user.id });
    await seedMetadata(older.id, {
      title: "Older public",
      visibility: "public",
      createdAt: new Date(Date.now() - 60_000),
    });

    const newer = await seedUpload({ userId: user.id });
    await seedMetadata(newer.id, { title: "Newer private", visibility: "private" });
    await seedVideoThumbnail(newer.id);

    const res = await agent.get("/api/v1/me/videos");
    expect(res.status).toBe(200);
    expect(res.body.totalHits).toBe(2);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.map((item) => item.title)).toEqual(["Newer private", "Older public"]);
    expect(res.body.items[0].thumbnailUrl).toBe(`/api/v1/videos/${newer.id}/thumbnail`);
    expect(res.body.items.some((item) => item.title === "Not mine")).toBe(false);
  });

  test("GET /me/videos paginates with page/limit and rejects limit >= 100", async () => {
    const agent = createTestAgent();
    const { user } = await registerSession(agent, {
      username: "myvideos_paginate",
      email: "myvideos_paginate@example.com",
    });

    for (let i = 0; i < 3; i += 1) {
      const upload = await seedUpload({ userId: user.id });
      await seedMetadata(upload.id, { title: `Video ${i}` });
    }

    const page1 = await agent.get("/api/v1/me/videos").query({ page: 1, limit: 2 });
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.page).toBe(1);
    expect(page1.body.limit).toBe(2);
    expect(page1.body.totalHits).toBe(3);
    expect(page1.body.totalPages).toBe(2);

    const page2 = await agent.get("/api/v1/me/videos").query({ page: 2, limit: 2 });
    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(1);

    const invalid = await agent.get("/api/v1/me/videos").query({ limit: 100 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("invalid_query");
  });

  test("GET /me/likes returns liked videos newest-like-first and excludes unliked/other-liked videos", async () => {
    const agent = createTestAgent();
    const { user } = await registerSession(agent, {
      username: "mylikes_owner",
      email: "mylikes_owner@example.com",
    });

    const notLiked = await seedUpload({ userId: user.id });
    await seedMetadata(notLiked.id, { title: "Not liked" });

    const other = await seedUser({ username: "mylikes_other", email: "mylikes_other@example.com" });
    const likedByOther = await seedUpload({ userId: other.id });
    await seedMetadata(likedByOther.id, { title: "Liked by other", visibility: "public" });
    await seedVideoLike(likedByOther.id, { userId: other.id });

    const likedOlder = await seedUpload({ userId: other.id });
    await seedMetadata(likedOlder.id, { title: "Liked older", visibility: "public" });
    await seedVideoLike(likedOlder.id, {
      userId: user.id,
      createdAt: new Date(Date.now() - 60_000),
    });

    const likedNewer = await seedUpload({ userId: other.id });
    await seedMetadata(likedNewer.id, { title: "Liked newer", visibility: "public" });
    await seedVideoLike(likedNewer.id, { userId: user.id });

    const res = await agent.get("/api/v1/me/likes");
    expect(res.status).toBe(200);
    expect(res.body.totalHits).toBe(2);
    expect(res.body.items.map((item) => item.title)).toEqual(["Liked newer", "Liked older"]);
  });

  test("GET /me/likes excludes hidden videos I don't own and private videos I lack access to", async () => {
    const agent = createTestAgent();
    const { user } = await registerSession(agent, {
      username: "mylikes_visibility",
      email: "mylikes_visibility@example.com",
    });
    const other = await seedUser({
      username: "mylikes_visibility_other",
      email: "mylikes_visibility_other@example.com",
    });

    const hiddenOthers = await seedUpload({ userId: other.id });
    await seedMetadata(hiddenOthers.id, { title: "Hidden by other", visibility: "hidden" });
    await seedVideoLike(hiddenOthers.id, { userId: user.id });

    const hiddenWithAccess = await seedUpload({ userId: other.id });
    await seedMetadata(hiddenWithAccess.id, {
      title: "Hidden with access",
      visibility: "hidden",
    });
    await seedVideoLike(hiddenWithAccess.id, { userId: user.id });
    await seedVideoAccess(hiddenWithAccess.id, user.id);

    const privateNoAccess = await seedUpload({ userId: other.id });
    await seedMetadata(privateNoAccess.id, { title: "Private no access", visibility: "private" });
    await seedVideoLike(privateNoAccess.id, { userId: user.id });

    const privateWithAccess = await seedUpload({ userId: other.id });
    await seedMetadata(privateWithAccess.id, { title: "Private with access", visibility: "private" });
    await seedVideoLike(privateWithAccess.id, { userId: user.id });
    await seedVideoAccess(privateWithAccess.id, user.id);

    const hiddenMine = await seedUpload({ userId: user.id });
    await seedMetadata(hiddenMine.id, { title: "Hidden mine", visibility: "hidden" });
    await seedVideoLike(hiddenMine.id, { userId: user.id });

    const publicOther = await seedUpload({ userId: other.id });
    await seedMetadata(publicOther.id, { title: "Public other", visibility: "public" });
    await seedVideoLike(publicOther.id, { userId: user.id });

    const res = await agent.get("/api/v1/me/likes").query({ limit: 50 });
    expect(res.status).toBe(200);
    const titles = res.body.items.map((item) => item.title).sort();
    expect(titles).toEqual([
      "Hidden mine",
      "Hidden with access",
      "Private with access",
      "Public other",
    ]);
  });

  test("GET /me/likes paginates with page/limit and rejects limit >= 100", async () => {
    const agent = createTestAgent();
    const { user } = await registerSession(agent, {
      username: "mylikes_paginate",
      email: "mylikes_paginate@example.com",
    });

    for (let i = 0; i < 3; i += 1) {
      const upload = await seedUpload({ userId: user.id });
      await seedMetadata(upload.id, { title: `Liked ${i}`, visibility: "public" });
      await seedVideoLike(upload.id, { userId: user.id });
    }

    const page1 = await agent.get("/api/v1/me/likes").query({ page: 1, limit: 2 });
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.totalHits).toBe(3);
    expect(page1.body.totalPages).toBe(2);

    const invalid = await agent.get("/api/v1/me/likes").query({ limit: 999 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("invalid_query");
  });
});

describe("me / history routes", () => {
  // Uses seedUser + seedUserApiKey + Bearer auth throughout (rather than
  // real POST /auth/register calls like the describe blocks above) - this
  // block registers/deletes enough times that going through the real,
  // rate-limited registration endpoint would trip authCredentialLimiter
  // (routes/auth.js, max 20/min, a module-level singleton shared across every
  // createApp() in this test file). Bearer auth also skips CSRF entirely, so
  // no fetchCsrf/X-CSRF-Token dance is needed for the DELETE requests here.
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  /**
   * Seeds a user with an API key and returns a supertest client pre-set with
   * the Bearer Authorization header, so callers can chain `.get(...)` etc.
   * directly without repeating the header on every request.
   *
   * @param {string} suffix Unique-ish suffix for the username/email/key.
   * @returns {Promise<{user: object, client: import('supertest').SuperTest}>}
   */
  async function seedAuthedClient(suffix) {
    const user = await seedUser({ username: `history_${suffix}`, email: `history_${suffix}@example.com` });
    const rawKey = `history-test-key-${suffix}`;
    await seedUserApiKey(user.id, rawKey);
    const client = createTestClient();
    return {
      user,
      get: (url) => client.get(url).set("Authorization", `Bearer ${rawKey}`),
      delete: (url) => client.delete(url).set("Authorization", `Bearer ${rawKey}`),
    };
  }

  test("unauthenticated GET /me/history returns 401", async () => {
    const client = createTestClient();
    const res = await client.get("/api/v1/me/history");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("unauthenticated DELETE /me/history returns 403 (CSRF check runs before auth for cookie-less requests)", async () => {
    const client = createTestClient();
    const res = await client.delete("/api/v1/me/history");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("csrf_invalid");
  });

  test("GET /me/history returns an empty list when the user has no history", async () => {
    const { get } = await seedAuthedClient("empty");

    const res = await get("/api/v1/me/history");
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.totalHits).toBe(0);
    expect(res.body.totalPages).toBe(0);
  });

  test("GET /me/history returns viewed videos newest-viewed first", async () => {
    const { user, get } = await seedAuthedClient("order");

    const older = await seedUpload({ userId: user.id });
    await seedMetadata(older.id, { title: "Watched older", visibility: "public" });
    await seedUserViewHistory(older.id, {
      userId: user.id,
      updatedAt: new Date(Date.now() - 60_000),
    });

    const newer = await seedUpload({ userId: user.id });
    await seedMetadata(newer.id, { title: "Watched newer", visibility: "public" });
    await seedUserViewHistory(newer.id, { userId: user.id });

    const res = await get("/api/v1/me/history");
    expect(res.status).toBe(200);
    expect(res.body.totalHits).toBe(2);
    expect(res.body.items.map((item) => item.title)).toEqual(["Watched newer", "Watched older"]);
    expect(typeof res.body.items[0].historyId).toBe("number");
    expect(res.body.items[0].viewedAt).toBeTruthy();
  });

  test("GET /me/history paginates with page/limit and rejects limit >= 100", async () => {
    const { user, get } = await seedAuthedClient("paginate");

    for (let i = 0; i < 3; i += 1) {
      const upload = await seedUpload({ userId: user.id });
      await seedMetadata(upload.id, { title: `Watched ${i}`, visibility: "public" });
      await seedUserViewHistory(upload.id, { userId: user.id });
    }

    const page1 = await get("/api/v1/me/history").query({ page: 1, limit: 2 });
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.totalHits).toBe(3);
    expect(page1.body.totalPages).toBe(2);

    const page2 = await get("/api/v1/me/history").query({ page: 2, limit: 2 });
    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(1);

    const invalid = await get("/api/v1/me/history").query({ limit: 100 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("invalid_query");
  });

  test("a repeat-viewed video upserts a single history row with a stable historyId", async () => {
    const { user, get } = await seedAuthedClient("repeat");

    const upload = await seedUpload({ userId: user.id });
    await seedMetadata(upload.id, { title: "Rewatched video", visibility: "public" });
    const firstView = await seedUserViewHistory(upload.id, {
      userId: user.id,
      updatedAt: new Date(Date.now() - 60_000),
    });
    const secondView = await seedUserViewHistory(upload.id, { userId: user.id });

    expect(secondView.id).toBe(firstView.id);

    const res = await get("/api/v1/me/history");
    expect(res.status).toBe(200);
    expect(res.body.totalHits).toBe(1);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].historyId).toBe(firstView.id);
  });

  test("GET /me/history excludes a video the owner later made private", async () => {
    const { user, get } = await seedAuthedClient("visibility");
    const other = await seedUser({
      username: "history_visibility_other",
      email: "history_visibility_other@example.com",
    });

    const madePrivate = await seedUpload({ userId: other.id });
    await seedMetadata(madePrivate.id, { title: "Now private", visibility: "private" });
    await seedUserViewHistory(madePrivate.id, { userId: user.id });

    const stillPublic = await seedUpload({ userId: other.id });
    await seedMetadata(stillPublic.id, { title: "Still public", visibility: "public" });
    await seedUserViewHistory(stillPublic.id, { userId: user.id });

    const res = await get("/api/v1/me/history");
    expect(res.status).toBe(200);
    expect(res.body.totalHits).toBe(1);
    expect(res.body.items.map((item) => item.title)).toEqual(["Still public"]);
  });

  test("DELETE /me/history/:id removes the row and it no longer appears in the list", async () => {
    const { user, get, delete: del } = await seedAuthedClient("delete_one");

    const upload = await seedUpload({ userId: user.id });
    await seedMetadata(upload.id, { title: "To remove", visibility: "public" });
    const entry = await seedUserViewHistory(upload.id, { userId: user.id });

    const deleteRes = await del(`/api/v1/me/history/${entry.id}`);
    expect(deleteRes.status).toBe(204);
    expect(deleteRes.body).toEqual({});

    const res = await get("/api/v1/me/history");
    expect(res.body.items).toEqual([]);
  });

  test("DELETE /me/history/:id owned by another user returns 404 and leaves the row intact", async () => {
    const owner = await seedUser({
      username: "history_delete_owner",
      email: "history_delete_owner@example.com",
    });
    const upload = await seedUpload({ userId: owner.id });
    await seedMetadata(upload.id, { title: "Owned by someone else", visibility: "public" });
    const entry = await seedUserViewHistory(upload.id, { userId: owner.id });

    const { delete: del } = await seedAuthedClient("delete_attacker");

    const res = await del(`/api/v1/me/history/${entry.id}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");

    const rows = await queryRows("SELECT * FROM USER_VIEW_HISTORY WHERE id = :id", {
      id: entry.id,
    });
    expect(rows).toHaveLength(1);
  });

  test("DELETE /me/history/:id with a non-numeric id returns 400", async () => {
    const { delete: del } = await seedAuthedClient("delete_badid");

    const res = await del("/api/v1/me/history/abc");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_id");
  });

  test("DELETE /me/history/:id for a nonexistent id returns 404", async () => {
    const { delete: del } = await seedAuthedClient("delete_missing");

    const res = await del("/api/v1/me/history/999999");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("DELETE /me/history clears every row for the caller only", async () => {
    const bob = await seedUser({
      username: "history_clear_bob",
      email: "history_clear_bob@example.com",
    });
    const bobUpload = await seedUpload({ userId: bob.id });
    await seedMetadata(bobUpload.id, { title: "Bob watched", visibility: "public" });
    await seedUserViewHistory(bobUpload.id, { userId: bob.id });

    const { user, get, delete: del } = await seedAuthedClient("clear_alice");

    const aliceUpload1 = await seedUpload({ userId: user.id });
    await seedMetadata(aliceUpload1.id, { title: "Alice watched 1", visibility: "public" });
    await seedUserViewHistory(aliceUpload1.id, { userId: user.id });

    const aliceUpload2 = await seedUpload({ userId: user.id });
    await seedMetadata(aliceUpload2.id, { title: "Alice watched 2", visibility: "public" });
    await seedUserViewHistory(aliceUpload2.id, { userId: user.id });

    const clear = await del("/api/v1/me/history");
    expect(clear.status).toBe(204);

    const aliceHistory = await get("/api/v1/me/history");
    expect(aliceHistory.body.items).toEqual([]);

    const bobRows = await queryRows("SELECT * FROM USER_VIEW_HISTORY WHERE user_id = :userId", {
      userId: bob.id,
    });
    expect(bobRows).toHaveLength(1);
  });
});
