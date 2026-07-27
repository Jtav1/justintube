import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { resolveSitedataPath } from "../../lib/sitedata-meta.js";
import { createTestAgent, createTestClient } from "../helpers/app.js";
import { resetTables, setupSchema } from "../helpers/db.js";

const avatarsDir = resolveSitedataPath("avatars");

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

/**
 * Checks whether a file exists on disk.
 *
 * @param {string} path Absolute path to check.
 * @returns {Promise<boolean>} True when the file exists.
 */
async function fileExists(path) {
  return access(path)
    .then(() => true)
    .catch(() => false);
}

describe("me / avatar routes", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("unauthenticated POST and DELETE /me/avatar (with a valid CSRF token) return 401", async () => {
    const agent = createTestAgent();
    const csrfToken = await fetchCsrf(agent);

    const post = await agent
      .post("/api/v1/me/avatar")
      .set("X-CSRF-Token", csrfToken)
      .attach("file", Buffer.from("x"), "a.jpg");
    expect(post.status).toBe(401);
    expect(post.body.error).toBe("unauthorized");

    const del = await agent.delete("/api/v1/me/avatar").set("X-CSRF-Token", csrfToken);
    expect(del.status).toBe(401);
    expect(del.body.error).toBe("unauthorized");
  });

  test("POST and DELETE /me/avatar without a CSRF token return 403", async () => {
    const client = createTestClient();

    const post = await client.post("/api/v1/me/avatar").attach("file", Buffer.from("x"), "a.jpg");
    expect(post.status).toBe(403);
    expect(post.body.error).toBe("csrf_invalid");

    const del = await client.delete("/api/v1/me/avatar");
    expect(del.status).toBe(403);
    expect(del.body.error).toBe("csrf_invalid");
  });

  test("POST /me/avatar with no file returns 400 invalid_body", async () => {
    const agent = createTestAgent();
    await registerSession(agent, {
      username: "avatar_nofile",
      email: "avatar_nofile@example.com",
    });
    const csrfToken = await fetchCsrf(agent);

    const res = await agent.post("/api/v1/me/avatar").set("X-CSRF-Token", csrfToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("POST /me/avatar with a disallowed extension returns 400 unsupported_file_type", async () => {
    const agent = createTestAgent();
    await registerSession(agent, {
      username: "avatar_badtype",
      email: "avatar_badtype@example.com",
    });
    const csrfToken = await fetchCsrf(agent);

    const res = await agent
      .post("/api/v1/me/avatar")
      .set("X-CSRF-Token", csrfToken)
      .attach("file", Buffer.from("nope"), "notes.txt");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unsupported_file_type");
    expect(res.body.allowed).toEqual(expect.arrayContaining(["jpg", "png"]));
  });

  test("POST /me/avatar with an oversized file returns 413 file_too_large", async () => {
    // MAX_AVATAR_SIZE_BYTES is set to 1024 in tests/setup/env.js.
    const agent = createTestAgent();
    await registerSession(agent, {
      username: "avatar_toobig",
      email: "avatar_toobig@example.com",
    });
    const csrfToken = await fetchCsrf(agent);

    const res = await agent
      .post("/api/v1/me/avatar")
      .set("X-CSRF-Token", csrfToken)
      .attach("file", Buffer.alloc(4096, 0x61), "big.jpg");

    expect(res.status).toBe(413);
    expect(res.body.error).toBe("file_too_large");
  });

  test("POST /me/avatar uploads, replaces on re-upload, and DELETE removes it", async () => {
    const agent = createTestAgent();
    await registerSession(agent, {
      username: "avatar_lifecycle",
      email: "avatar_lifecycle@example.com",
    });
    const csrfToken = await fetchCsrf(agent);

    const first = await agent
      .post("/api/v1/me/avatar")
      .set("X-CSRF-Token", csrfToken)
      .attach("file", Buffer.from("first"), "first.jpg");
    expect(first.status).toBe(200);
    expect(typeof first.body.avatarFilename).toBe("string");
    expect(first.body.avatarFilename.endsWith(".jpg")).toBe(true);

    const firstFilename = first.body.avatarFilename;
    expect(await fileExists(join(avatarsDir, firstFilename))).toBe(true);

    const settings = await agent.get("/api/v1/me/settings");
    expect(settings.body.avatarFilename).toBe(firstFilename);

    const second = await agent
      .post("/api/v1/me/avatar")
      .set("X-CSRF-Token", csrfToken)
      .attach("file", Buffer.from("second"), "second.png");
    expect(second.status).toBe(200);
    const secondFilename = second.body.avatarFilename;
    expect(secondFilename).not.toBe(firstFilename);
    expect(await fileExists(join(avatarsDir, secondFilename))).toBe(true);
    expect(await fileExists(join(avatarsDir, firstFilename))).toBe(false);

    const del = await agent.delete("/api/v1/me/avatar").set("X-CSRF-Token", csrfToken);
    expect(del.status).toBe(204);
    expect(await fileExists(join(avatarsDir, secondFilename))).toBe(false);

    const settingsAfterDelete = await agent.get("/api/v1/me/settings");
    expect(settingsAfterDelete.body.avatarFilename).toBeNull();

    // Idempotent: deleting again with no avatar set still succeeds.
    const delAgain = await agent.delete("/api/v1/me/avatar").set("X-CSRF-Token", csrfToken);
    expect(delAgain.status).toBe(204);
  });
});
