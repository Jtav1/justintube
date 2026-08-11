import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { hashPassword } from "../../lib/auth/password.js";
import { createTestAgent, createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedLivestream,
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
  return res.body.csrfToken;
}

/**
 * Logs in a seeded user and returns a rotated CSRF token.
 *
 * @param {import('supertest').SuperAgentTest} agent Supertest agent with cookies.
 * @param {{ username: string, password: string }} credentials Login credentials.
 * @returns {Promise<string>} CSRF token for subsequent mutating requests.
 */
async function loginSession(agent, credentials) {
  const csrf = await fetchCsrf(agent);
  const res = await agent
    .post("/api/v1/auth/login")
    .set("X-CSRF-Token", csrf)
    .send(credentials);
  expect(res.status).toBe(200);
  return res.body.csrfToken;
}

describe("livestreams routes", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("list only returns public live streams to anonymous callers", async () => {
    const owner = await seedUser({ username: "pub-streamer", email: "pub@example.com" });
    const other = await seedUser({ username: "priv-streamer", email: "priv@example.com" });
    await seedLivestream(owner.id, { status: "live", visibility: "public", title: "Public stream" });
    await seedLivestream(other.id, { status: "live", visibility: "private", title: "Private stream" });

    const client = createTestClient();
    const res = await client.get("/api/v1/livestreams");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toBe("Public stream");
    expect(res.body.items[0].streamer.username).toBe("pub-streamer");
  });

  test("get returns 404 for a private stream to an anonymous caller", async () => {
    const owner = await seedUser({ username: "hidden-streamer", email: "hidden@example.com" });
    const stream = await seedLivestream(owner.id, { status: "live", visibility: "private" });

    const client = createTestClient();
    const res = await client.get(`/api/v1/livestreams/${stream.id}`);
    expect(res.status).toBe(404);
  });

  test("get returns a private stream to its owner", async () => {
    const passwordHash = await hashPassword("password123");
    const owner = await seedUser({
      username: "owner-view",
      email: "owner-view@example.com",
      passwordHash,
      emailVerified: true,
      uploader: true,
    });
    const stream = await seedLivestream(owner.id, { status: "live", visibility: "private" });

    const agent = createTestAgent();
    await loginSession(agent, { username: "owner-view", password: "password123" });
    const res = await agent.get(`/api/v1/livestreams/${stream.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(stream.id);
  });

  test("patch rejects non-owner, non-admin callers", async () => {
    const passwordHash = await hashPassword("password123");
    const owner = await seedUser({ username: "owner-a", email: "owner-a@example.com" });
    await seedUser({
      username: "not-owner",
      email: "not-owner@example.com",
      passwordHash,
      emailVerified: true,
      uploader: true,
    });
    const stream = await seedLivestream(owner.id, { visibility: "public" });

    const agent = createTestAgent();
    const csrfToken = await loginSession(agent, { username: "not-owner", password: "password123" });
    const res = await agent
      .patch(`/api/v1/livestreams/${stream.id}`)
      .set("X-CSRF-Token", csrfToken)
      .send({ title: "Hijacked" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("patch updates title/description/visibility for the owner", async () => {
    const passwordHash = await hashPassword("password123");
    const owner = await seedUser({
      username: "owner-b",
      email: "owner-b@example.com",
      passwordHash,
      emailVerified: true,
      uploader: true,
    });
    const stream = await seedLivestream(owner.id, { visibility: "private" });

    const agent = createTestAgent();
    const csrfToken = await loginSession(agent, { username: "owner-b", password: "password123" });
    const res = await agent
      .patch(`/api/v1/livestreams/${stream.id}`)
      .set("X-CSRF-Token", csrfToken)
      .send({ title: "My stream", description: "Playing games", visibility: "public" });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("My stream");
    expect(res.body.description).toBe("Playing games");
    expect(res.body.visibility).toBe("public");
  });

  test("patch rejects an invalid visibility value", async () => {
    const passwordHash = await hashPassword("password123");
    const owner = await seedUser({
      username: "owner-c",
      email: "owner-c@example.com",
      passwordHash,
      emailVerified: true,
      uploader: true,
    });
    const stream = await seedLivestream(owner.id);

    const agent = createTestAgent();
    const csrfToken = await loginSession(agent, { username: "owner-c", password: "password123" });
    const res = await agent
      .patch(`/api/v1/livestreams/${stream.id}`)
      .set("X-CSRF-Token", csrfToken)
      .send({ visibility: "not-a-real-value" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("playback returns a null playbackUrl placeholder", async () => {
    const owner = await seedUser({ username: "playback-owner", email: "playback@example.com" });
    const stream = await seedLivestream(owner.id, { status: "live", visibility: "public" });

    const client = createTestClient();
    const res = await client.get(`/api/v1/livestreams/${stream.id}/playback`);
    expect(res.status).toBe(200);
    expect(res.body.playbackUrl).toBeNull();
    expect(res.body.status).toBe("live");
  });

  test("users/:username/live reports false when offline", async () => {
    const owner = await seedUser({ username: "offline-user", email: "offline@example.com" });
    await seedLivestream(owner.id, { status: "offline", visibility: "public" });

    const client = createTestClient();
    const res = await client.get("/api/v1/users/offline-user/live");
    expect(res.status).toBe(200);
    expect(res.body.live).toBe(false);
  });

  test("users/:username/live reports true with viewer count when live and public", async () => {
    const owner = await seedUser({ username: "live-user", email: "live@example.com" });
    await seedLivestream(owner.id, {
      status: "live",
      visibility: "public",
      title: "Going live",
      viewerCount: 42,
    });

    const client = createTestClient();
    const res = await client.get("/api/v1/users/live-user/live");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ live: true, title: "Going live", viewerCount: 42 });
  });
});
