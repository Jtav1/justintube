import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { createTestAgent, createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedPlaylist,
  seedSubscription,
  seedUser,
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

describe("me / subscriptions, subscribers, and playlists routes", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("unauthenticated GET /me/subscriptions returns 401", async () => {
    const client = createTestClient();
    const res = await client.get("/api/v1/me/subscriptions");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("unauthenticated GET /me/subscribers returns 401", async () => {
    const client = createTestClient();
    const res = await client.get("/api/v1/me/subscribers");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("unauthenticated GET /me/playlists returns 401", async () => {
    const client = createTestClient();
    const res = await client.get("/api/v1/me/playlists");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("GET /me/subscriptions returns empty list when I follow no one", async () => {
    const agent = createTestAgent();
    await registerSession(agent, {
      username: "subs_empty",
      email: "subs_empty@example.com",
    });

    const res = await agent.get("/api/v1/me/subscriptions");
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.totalHits).toBe(0);
  });

  test("GET /me/subscriptions returns hydrated users I'm subscribed to, newest first", async () => {
    const agent = createTestAgent();
    const { user } = await registerSession(agent, {
      username: "subs_owner",
      email: "subs_owner@example.com",
    });

    const older = await seedUser({
      username: "subs_older",
      email: "subs_older@example.com",
      displayName: "Older Channel",
      avatarFilename: "older.jpg",
    });
    await seedSubscription(user.id, older.id, { createdAt: new Date(Date.now() - 60_000) });

    const newer = await seedUser({
      username: "subs_newer",
      email: "subs_newer@example.com",
      displayName: "Newer Channel",
      avatarFilename: null,
    });
    await seedSubscription(user.id, newer.id);

    // Not subscribed to this one; must not appear.
    await seedUser({ username: "subs_unrelated", email: "subs_unrelated@example.com" });

    const res = await agent.get("/api/v1/me/subscriptions");
    expect(res.status).toBe(200);
    expect(res.body.totalHits).toBe(2);
    expect(res.body.items.map((item) => item.username)).toEqual(["subs_newer", "subs_older"]);
    expect(res.body.items[1]).toMatchObject({
      username: "subs_older",
      displayName: "Older Channel",
      avatarFilename: "older.jpg",
    });
    expect(res.body.items[0].avatarFilename).toBeNull();
    expect(res.body.items[0]).not.toHaveProperty("passwordHash");
  });

  test("GET /me/subscriptions paginates with page/limit and rejects limit >= 100", async () => {
    const agent = createTestAgent();
    const { user } = await registerSession(agent, {
      username: "subs_paginate",
      email: "subs_paginate@example.com",
    });

    for (let i = 0; i < 3; i += 1) {
      const other = await seedUser({
        username: `subs_paginate_target_${i}`,
        email: `subs_paginate_target_${i}@example.com`,
      });
      await seedSubscription(user.id, other.id);
    }

    const page1 = await agent.get("/api/v1/me/subscriptions").query({ page: 1, limit: 2 });
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.totalHits).toBe(3);
    expect(page1.body.totalPages).toBe(2);

    const invalid = await agent.get("/api/v1/me/subscriptions").query({ limit: 100 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("invalid_query");
  });

  test("GET /me/subscribers returns hydrated users subscribed to me, newest first", async () => {
    const agent = createTestAgent();
    const { user } = await registerSession(agent, {
      username: "subscribers_owner",
      email: "subscribers_owner@example.com",
    });

    const olderFollower = await seedUser({
      username: "subscribers_older",
      email: "subscribers_older@example.com",
      displayName: "Older Follower",
    });
    await seedSubscription(olderFollower.id, user.id, {
      createdAt: new Date(Date.now() - 60_000),
    });

    const newerFollower = await seedUser({
      username: "subscribers_newer",
      email: "subscribers_newer@example.com",
      displayName: "Newer Follower",
    });
    await seedSubscription(newerFollower.id, user.id);

    // Someone I follow, but who doesn't follow me; must not appear.
    const notAFollower = await seedUser({
      username: "subscribers_unrelated",
      email: "subscribers_unrelated@example.com",
    });
    await seedSubscription(user.id, notAFollower.id);

    const res = await agent.get("/api/v1/me/subscribers");
    expect(res.status).toBe(200);
    expect(res.body.totalHits).toBe(2);
    expect(res.body.items.map((item) => item.username)).toEqual([
      "subscribers_newer",
      "subscribers_older",
    ]);
    expect(res.body.items[0]).not.toHaveProperty("passwordHash");
  });

  test("GET /me/playlists returns only my playlists with the documented fields", async () => {
    const agent = createTestAgent();
    const { user } = await registerSession(agent, {
      username: "playlists_owner",
      email: "playlists_owner@example.com",
    });

    const other = await seedUser({
      username: "playlists_other",
      email: "playlists_other@example.com",
    });
    await seedPlaylist({ userId: other.id, title: "Not mine" });

    const lastAddedAt = new Date();
    await seedPlaylist({
      userId: user.id,
      title: "My playlist",
      description: "A description",
      visibility: "public",
      lastAddedAt,
    });

    const res = await agent.get("/api/v1/me/playlists");
    expect(res.status).toBe(200);
    expect(res.body.totalHits).toBe(1);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      title: "My playlist",
      description: "A description",
      visibility: "public",
    });
    expect(res.body.items[0]).toHaveProperty("id");
    expect(res.body.items[0]).toHaveProperty("createdAt");
    expect(new Date(res.body.items[0].lastAddedAt).getTime()).toBe(lastAddedAt.getTime());
    expect(res.body.items.some((item) => item.title === "Not mine")).toBe(false);
  });

  test("GET /me/playlists paginates with page/limit and rejects limit >= 100", async () => {
    const agent = createTestAgent();
    const { user } = await registerSession(agent, {
      username: "playlists_paginate",
      email: "playlists_paginate@example.com",
    });

    for (let i = 0; i < 3; i += 1) {
      await seedPlaylist({ userId: user.id, title: `Playlist ${i}` });
    }

    const page1 = await agent.get("/api/v1/me/playlists").query({ page: 1, limit: 2 });
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.totalHits).toBe(3);
    expect(page1.body.totalPages).toBe(2);

    const invalid = await agent.get("/api/v1/me/playlists").query({ limit: 999 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("invalid_query");
  });
});
