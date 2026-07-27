import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { User } from "../../lib/models/index.js";
import { createTestAgent, createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedMetadata,
  seedUpload,
  seedUser,
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
    ["username", "new_username"],
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
