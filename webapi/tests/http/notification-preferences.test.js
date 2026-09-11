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

  test("GET after registration reflects each type's seeded default preference", async () => {
    // Registration seeds an explicit row per active type (see
    // ensureUserNotificationSettings), so this asserts against the real
    // seeded values rather than a "no row" fallback. In-app delivery
    // defaults to on for every type; email delivery for
    // subscription/like/comment is opt-in (default off), everything else
    // opt-out (default on).
    const EMAIL_OPT_IN_TYPES = new Set(["subscription", "like", "comment"]);

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
      const expectedEmailDefault = !EMAIL_OPT_IN_TYPES.has(pref.notificationType);
      expect(pref.emailEnabled).toBe(expectedEmailDefault);
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
    // "enabled" (in-app) defaults to true for every type; only the patched
    // "like" row should have flipped to false.
    const others = get.body.preferences.filter(
      (pref) => pref.notificationType !== "like",
    );
    for (const pref of others) {
      expect(pref.enabled).toBe(true);
    }
  });

  test("PATCH toggles only emailEnabled, leaving enabled untouched", async () => {
    const agent = createTestAgent();
    await registerSession(agent, {
      username: "prefs_email_toggle",
      email: "prefs_email_toggle@example.com",
    });
    const csrfToken = await fetchCsrf(agent);

    // "admin" defaults to enabled/emailEnabled: true, so the untouched field
    // staying true after this patch demonstrates independence, not a
    // coincidence of the type's default.
    const patch = await agent
      .patch("/api/v1/me/notification-preferences")
      .set("X-CSRF-Token", csrfToken)
      .send({ preferences: [{ notificationType: "admin", emailEnabled: false }] });

    expect(patch.status).toBe(200);
    const patchedLike = patch.body.preferences.find(
      (pref) => pref.notificationType === "admin",
    );
    expect(patchedLike.emailEnabled).toBe(false);
    expect(patchedLike.enabled).toBe(true);

    const get = await agent.get("/api/v1/me/notification-preferences");
    expect(get.status).toBe(200);
    const like = get.body.preferences.find(
      (pref) => pref.notificationType === "admin",
    );
    expect(like.emailEnabled).toBe(false);
    expect(like.enabled).toBe(true);
  });

  test("PATCH toggles only enabled, leaving emailEnabled untouched", async () => {
    const agent = createTestAgent();
    await registerSession(agent, {
      username: "prefs_inapp_toggle",
      email: "prefs_inapp_toggle@example.com",
    });
    const csrfToken = await fetchCsrf(agent);

    // "subscriber" is not an enabledLocked type, so its in-app delivery can
    // be toggled off independently of email - unlike admin/moderation/account.
    const patch = await agent
      .patch("/api/v1/me/notification-preferences")
      .set("X-CSRF-Token", csrfToken)
      .send({ preferences: [{ notificationType: "subscriber", enabled: false }] });

    expect(patch.status).toBe(200);
    const patchedLike = patch.body.preferences.find(
      (pref) => pref.notificationType === "subscriber",
    );
    expect(patchedLike.enabled).toBe(false);
    expect(patchedLike.emailEnabled).toBe(true);
  });

  test.each(["admin", "moderation", "account"])(
    "PATCH rejects disabling in-app delivery for the enabledLocked type %s",
    async (notificationType) => {
      const agent = createTestAgent();
      await registerSession(agent, {
        username: `prefs_locked_${notificationType}`,
        email: `prefs_locked_${notificationType}@example.com`,
      });
      const csrfToken = await fetchCsrf(agent);

      const res = await agent
        .patch("/api/v1/me/notification-preferences")
        .set("X-CSRF-Token", csrfToken)
        .send({ preferences: [{ notificationType, enabled: false }] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_body");

      const get = await agent.get("/api/v1/me/notification-preferences");
      const pref = get.body.preferences.find((p) => p.notificationType === notificationType);
      expect(pref.enabled).toBe(true);
      expect(pref.enabledLocked).toBe(true);
    },
  );

  test("PATCH still allows disabling email for an enabledLocked type", async () => {
    const agent = createTestAgent();
    await registerSession(agent, {
      username: "prefs_locked_email_toggle",
      email: "prefs_locked_email_toggle@example.com",
    });
    const csrfToken = await fetchCsrf(agent);

    const patch = await agent
      .patch("/api/v1/me/notification-preferences")
      .set("X-CSRF-Token", csrfToken)
      .send({ preferences: [{ notificationType: "admin", emailEnabled: false }] });

    expect(patch.status).toBe(200);
    const pref = patch.body.preferences.find((p) => p.notificationType === "admin");
    expect(pref.emailEnabled).toBe(false);
    expect(pref.enabled).toBe(true);
    expect(pref.enabledLocked).toBe(true);
  });

  test("GET marks moderation/account/admin as enabledLocked, other types as not locked", async () => {
    const agent = createTestAgent();
    await registerSession(agent, {
      username: "prefs_locked_flags",
      email: "prefs_locked_flags@example.com",
    });

    const res = await agent.get("/api/v1/me/notification-preferences");
    expect(res.status).toBe(200);
    const byType = new Map(res.body.preferences.map((p) => [p.notificationType, p]));
    expect(byType.get("admin").enabledLocked).toBe(true);
    expect(byType.get("moderation").enabledLocked).toBe(true);
    expect(byType.get("account").enabledLocked).toBe(true);
    expect(byType.get("subscriber").enabledLocked).toBe(false);
    expect(byType.get("like").enabledLocked).toBe(false);
  });

  test("PATCH with neither enabled nor emailEnabled returns 400", async () => {
    const agent = createTestAgent();
    await registerSession(agent, {
      username: "prefs_neither",
      email: "prefs_neither@example.com",
    });
    const csrfToken = await fetchCsrf(agent);

    const res = await agent
      .patch("/api/v1/me/notification-preferences")
      .set("X-CSRF-Token", csrfToken)
      .send({ preferences: [{ notificationType: "like" }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
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
      where: { userId: bob.id, notificationTypeId: commentType.id },
    });
    expect(bobSettings).toHaveLength(1);
    expect(bobSettings[0].enabled).toBe(false);
  });
});
