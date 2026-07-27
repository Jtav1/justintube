import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { Notification } from "../../lib/models/index.js";
import { createTestAgent, createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedNotification,
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

describe("notifications routes", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  describe("GET /api/v1/notifications", () => {
    test("unauthenticated GET returns 401", async () => {
      const client = createTestClient();
      const res = await client.get("/api/v1/notifications");
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("unauthorized");
    });

    test("returns only the requesting user's notifications, newest first", async () => {
      const bob = await seedUser({ username: "bob_notif", email: "bob_notif@example.com" });

      const agent = createTestAgent();
      const { user: alice } = await registerSession(agent, {
        username: "alice_notif",
        email: "alice_notif@example.com",
      });

      await seedNotification(bob.id, { title: "Bob's notification" });
      const older = await seedNotification(alice.id, {
        title: "Older",
        createdAt: new Date(Date.now() - 60_000),
      });
      const newer = await seedNotification(alice.id, {
        title: "Newer",
        readAt: new Date(),
      });

      const res = await agent.get("/api/v1/notifications");
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.items[0].id).toBe(newer.id);
      expect(res.body.items[1].id).toBe(older.id);

      const item = res.body.items[0];
      expect(typeof item.notificationType).toBe("string");
      expect(item.title).toBe("Newer");
      expect(item.message).toBe("Sample notification message");
      expect(item.readAt).not.toBeNull();
      expect(item.createdAt).toBeTruthy();
      expect(res.body.page).toBe(1);
      expect(res.body.totalHits).toBe(2);
    });

    test("limit of 100 or more is rejected", async () => {
      const agent = createTestAgent();
      await registerSession(agent, {
        username: "alice_limit",
        email: "alice_limit@example.com",
      });

      const res = await agent.get("/api/v1/notifications").query({ limit: 100 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_query");
    });
  });

  describe("POST /api/v1/notifications/read", () => {
    test("unauthenticated POST returns 403 (no CSRF token on an anonymous session)", async () => {
      const client = createTestClient();
      const res = await client
        .post("/api/v1/notifications/read")
        .send({ notificationIds: [1] });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("csrf_invalid");
    });

    test("without a CSRF token returns 403", async () => {
      const agent = createTestAgent();
      await registerSession(agent, {
        username: "alice_nocsrf",
        email: "alice_nocsrf@example.com",
      });

      const res = await agent
        .post("/api/v1/notifications/read")
        .send({ notificationIds: [1] });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("csrf_invalid");
    });

    test("rejects a missing or invalid notificationIds body", async () => {
      const agent = createTestAgent();
      await registerSession(agent, {
        username: "alice_badbody",
        email: "alice_badbody@example.com",
      });
      const csrfToken = await fetchCsrf(agent);

      const missing = await agent
        .post("/api/v1/notifications/read")
        .set("X-CSRF-Token", csrfToken)
        .send({});
      expect(missing.status).toBe(400);
      expect(missing.body.error).toBe("invalid_body");

      const invalid = await agent
        .post("/api/v1/notifications/read")
        .set("X-CSRF-Token", csrfToken)
        .send({ notificationIds: ["not-a-number"] });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toBe("invalid_body");
    });

    test("marks only the requesting user's notifications as read", async () => {
      const bob = await seedUser({ username: "bob_read", email: "bob_read@example.com" });
      const bobNotification = await seedNotification(bob.id);

      const agent = createTestAgent();
      const { user: alice } = await registerSession(agent, {
        username: "alice_read",
        email: "alice_read@example.com",
      });
      const aliceNotification = await seedNotification(alice.id);
      const csrfToken = await fetchCsrf(agent);

      const res = await agent
        .post("/api/v1/notifications/read")
        .set("X-CSRF-Token", csrfToken)
        .send({ notificationIds: [aliceNotification.id, bobNotification.id] });

      expect(res.status).toBe(204);
      expect(res.body).toEqual({});

      const aliceRow = await Notification.findByPk(aliceNotification.id);
      expect(aliceRow.readAt).not.toBeNull();

      const bobRow = await Notification.findByPk(bobNotification.id);
      expect(bobRow.readAt).toBeNull();
    });
  });
});
