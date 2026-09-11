import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { hashPassword } from "../../lib/auth/password.js";
import { createTestAgent, createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedStreamKey,
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

/**
 * Seeds and logs in an uploader-eligible user, returning the agent + csrf.
 *
 * @param {object} [overrides] USERS overrides.
 * @returns {Promise<{ agent: import('supertest').SuperAgentTest, csrfToken: string, user: object }>}
 */
async function loginUploader(overrides = {}) {
  const passwordHash = await hashPassword("password123");
  const user = await seedUser({
    username: "streamer",
    email: "streamer@example.com",
    passwordHash,
    emailVerified: true,
    uploader: true,
    ...overrides,
  });
  const agent = createTestAgent();
  const csrfToken = await loginSession(agent, {
    username: user.username,
    password: "password123",
  });
  return { agent, csrfToken, user };
}

describe("me / stream-key routes", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("unauthenticated get returns 401", async () => {
    const client = createTestClient();
    const res = await client.get("/api/v1/me/stream-key");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("get rejects non-uploader users", async () => {
    const passwordHash = await hashPassword("password123");
    await seedUser({
      username: "nonuploader",
      email: "nonuploader@example.com",
      passwordHash,
      emailVerified: true,
      uploader: false,
    });
    const agent = createTestAgent();
    await loginSession(agent, { username: "nonuploader", password: "password123" });

    const res = await agent.get("/api/v1/me/stream-key");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("get returns 404 when no key exists yet", async () => {
    const { agent } = await loginUploader();
    const res = await agent.get("/api/v1/me/stream-key");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("rotate creates a plaintext key once; subsequent get is masked only", async () => {
    const { agent, csrfToken } = await loginUploader();

    const rotate = await agent
      .post("/api/v1/me/stream-key/rotate")
      .set("X-CSRF-Token", csrfToken);

    expect(rotate.status).toBe(200);
    expect(typeof rotate.body.key).toBe("string");
    expect(rotate.body.key.startsWith("sk_")).toBe(true);
    expect(rotate.body.keyDisplay).toContain("*");
    expect(rotate.body.keyHash).toBeUndefined();
    expect(rotate.body.keyPrefix).toBeUndefined();

    const get = await agent.get("/api/v1/me/stream-key");
    expect(get.status).toBe(200);
    expect(get.body.key).toBeUndefined();
    expect(get.body.keyHash).toBeUndefined();
    expect(get.body.keyDisplay).toContain("*");
  });

  test("rotate also find-or-creates the caller's livestream row", async () => {
    const { agent, csrfToken } = await loginUploader();

    const rotate = await agent
      .post("/api/v1/me/stream-key/rotate")
      .set("X-CSRF-Token", csrfToken);
    expect(rotate.status).toBe(200);
    expect(typeof rotate.body.livestreamId).toBe("number");

    const livestream = await agent.get("/api/v1/me/livestream");
    expect(livestream.status).toBe(200);
    expect(livestream.body.id).toBe(rotate.body.livestreamId);
    expect(livestream.body.status).toBe("offline");

    const rotateAgain = await agent
      .post("/api/v1/me/stream-key/rotate")
      .set("X-CSRF-Token", csrfToken);
    expect(rotateAgain.body.livestreamId).toBe(rotate.body.livestreamId);
  });

  test("get my livestream returns 404 before any key has been generated", async () => {
    const { agent } = await loginUploader();
    const res = await agent.get("/api/v1/me/livestream");
    expect(res.status).toBe(404);
  });

  test("rotate replaces a previous key so the old one no longer authorizes", async () => {
    const { agent, csrfToken, user } = await loginUploader();
    const first = await seedStreamKey(user.id, "sk_original_raw_key");

    const rotate = await agent
      .post("/api/v1/me/stream-key/rotate")
      .set("X-CSRF-Token", csrfToken);
    expect(rotate.status).toBe(200);
    expect(rotate.body.key).not.toBe(first.rawKey);

    const authorize = await createTestClient()
      .post("/internal/livestreams/authorize")
      .set("Authorization", "Bearer test-internal-token")
      .send({ streamKey: first.rawKey });
    expect(authorize.status).toBe(403);
  });

  test("delete soft-revokes the key", async () => {
    const { agent, csrfToken, user } = await loginUploader();
    await seedStreamKey(user.id, "sk_to_revoke");

    const del = await agent.delete("/api/v1/me/stream-key").set("X-CSRF-Token", csrfToken);
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);

    const authorize = await createTestClient()
      .post("/internal/livestreams/authorize")
      .set("Authorization", "Bearer test-internal-token")
      .send({ streamKey: "sk_to_revoke" });
    expect(authorize.status).toBe(403);
  });
});
