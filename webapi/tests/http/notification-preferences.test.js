import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { NotificationType, UserNotificationSetting } from "../../lib/models/index.js";
import { createTestAgent, createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedUser,
  seedUserNotificationSetting,
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

describe("me / notification-preferences routes", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("unauthenticated GET returns 401", async () => {
    const client = createTestClient();
    const res = await client.get("/api/v1/me/notification-preferences");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("GET with no rows defaults every active type to enabled: true", async () => {
    const activeTypes = await NotificationType.findAll({
      where: { enabled: true },
    });
    expect(activeTypes.length).toBeGreaterThan(0);

    const agent = createTestAgent();
    await registerSession(agent, {
      username: "prefs_default",
      email: "prefs_default@example.com",
    });

    const res = await agent.get("/api/v1/me/notification-preferences");
    expect(res.status).toBe(200);
    expect(res.body.preferences).toHaveLength(activeTypes.length);
    for (const pref of res.body.preferences) {
      expect(pref.enabled).toBe(true);
    }
  });

  test("PATCH toggles a preference and it's reflected on the next GET", async () => {
    const agent = createTestAgent();
    await registerSession(agent, {
      username: "prefs_toggle",
      email: "prefs_toggle@example.com",
    });
    const csrfToken = await fetchCsrf(agent);

    const patch = await agent
      .patch("/api/v1/me/notification-preferences")
      .set("X-CSRF-Token", csrfToken)
      .send({ preferences: [{ notificationType: "like", enabled: false }] });

    expect(patch.status).toBe(200);
    const patchedLike = patch.body.preferences.find(
      (pref) => pref.notificationType === "like",
    );
    expect(patchedLike.enabled).toBe(false);

    const get = await agent.get("/api/v1/me/notification-preferences");
    expect(get.status).toBe(200);
    const like = get.body.preferences.find(
      (pref) => pref.notificationType === "like",
    );
    expect(like.enabled).toBe(false);
    const others = get.body.preferences.filter(
      (pref) => pref.notificationType !== "like",
    );
    for (const pref of others) {
      expect(pref.enabled).toBe(true);
    }
  });

  test("PATCH with an unknown notificationType returns 400", async () => {
    const agent = createTestAgent();
    await registerSession(agent, {
      username: "prefs_unknown",
      email: "prefs_unknown@example.com",
    });
    const csrfToken = await fetchCsrf(agent);

    const res = await agent
      .patch("/api/v1/me/notification-preferences")
      .set("X-CSRF-Token", csrfToken)
      .send({ preferences: [{ notificationType: "not-a-real-type", enabled: false }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("PATCH without a CSRF token returns 403", async () => {
    const agent = createTestAgent();
    await registerSession(agent, {
      username: "prefs_nocsrf",
      email: "prefs_nocsrf@example.com",
    });

    const res = await agent
      .patch("/api/v1/me/notification-preferences")
      .send({ preferences: [{ notificationType: "like", enabled: false }] });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("csrf_invalid");
  });

  test("one user's PATCH does not affect another user's preferences", async () => {
    const bob = await seedUser({
      username: "bob_prefs",
      email: "bob_prefs@example.com",
    });
    const commentType = await NotificationType.findOne({
      where: { name: "comment" },
    });
    await seedUserNotificationSetting(bob.id, {
      notificationTypeId: commentType.id,
      enabled: false,
    });

    const agent = createTestAgent();
    await registerSession(agent, {
      username: "alice_prefs",
      email: "alice_prefs@example.com",
    });
    const csrfToken = await fetchCsrf(agent);
    const patch = await agent
      .patch("/api/v1/me/notification-preferences")
      .set("X-CSRF-Token", csrfToken)
      .send({ preferences: [{ notificationType: "comment", enabled: false }] });
    expect(patch.status).toBe(200);

    const bobSettings = await UserNotificationSetting.findAll({
      where: { userId: bob.id },
    });
    expect(bobSettings).toHaveLength(1);
    expect(bobSettings[0].enabled).toBe(false);
  });
});
