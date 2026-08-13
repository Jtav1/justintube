import {
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "@jest/globals";
import { Role } from "../../lib/models/index.js";
import { createTestClient } from "../helpers/app.js";
import {
  queryRows,
  resetTables,
  seedUser,
  seedUserApiKey,
  setupSchema,
} from "../helpers/db.js";

/**
 * Seeds a user with the given role name and an API key for Bearer auth.
 *
 * @param {string} roleName Role name (`admin`, `viewer`, …).
 * @param {string} rawKey Plaintext API key for Authorization headers.
 * @param {object} [overrides] Extra `seedUser` overrides.
 * @returns {Promise<{id: number} & Record<string, unknown>>} Seeded user record.
 */
async function seedUserWithRoleAndKey(roleName, rawKey, overrides = {}) {
  const role = await Role.findOne({ where: { name: roleName } });
  const user = await seedUser({
    roleId: role?.id ?? null,
    emailVerified: true,
    ...overrides,
  });
  await seedUserApiKey(user.id, rawKey);
  return user;
}

/**
 * HTTP contract tests for the admin sitewide-broadcast notification endpoint.
 */
describe("POST /admin/notifications/broadcast (adminBroadcastNotification)", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("rejects non-admins", async () => {
    await seedUserWithRoleAndKey("viewer", "broadcast-viewer-key");

    const res = await client
      .post("/api/v1/admin/notifications/broadcast")
      .set("Authorization", "Bearer broadcast-viewer-key")
      .send({ title: "Hello", message: "World" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("rejects an empty title or message", async () => {
    await seedUserWithRoleAndKey("admin", "broadcast-empty-key");

    const noTitle = await client
      .post("/api/v1/admin/notifications/broadcast")
      .set("Authorization", "Bearer broadcast-empty-key")
      .send({ title: "   ", message: "World" });
    expect(noTitle.status).toBe(400);
    expect(noTitle.body.error).toBe("invalid_body");

    const noMessage = await client
      .post("/api/v1/admin/notifications/broadcast")
      .set("Authorization", "Bearer broadcast-empty-key")
      .send({ title: "Hello", message: "" });
    expect(noMessage.status).toBe(400);
    expect(noMessage.body.error).toBe("invalid_body");
  });

  test("notifies every user, including the sending admin", async () => {
    const admin = await seedUserWithRoleAndKey("admin", "broadcast-admin-key");
    const userA = await seedUserWithRoleAndKey("viewer", "broadcast-user-a-key");
    const userB = await seedUserWithRoleAndKey("viewer", "broadcast-user-b-key");

    const res = await client
      .post("/api/v1/admin/notifications/broadcast")
      .set("Authorization", "Bearer broadcast-admin-key")
      .send({ title: "Sitewide Alert", message: "Scheduled maintenance tonight." });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.notifiedCount).toBe(3);

    for (const user of [admin, userA, userB]) {
      const rows = await queryRows("SELECT * FROM NOTIFICATIONS WHERE user_id = :userId", {
        userId: user.id,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe("Sitewide Alert");
      expect(rows[0].message).toBe("Scheduled maintenance tonight.");
      expect(rows[0].target).toBeNull();
    }
  });
});

/**
 * HTTP contract tests for the admin targeted-moderation notification endpoint.
 */
describe("POST /admin/notifications/moderation (adminModerationNotification)", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("rejects non-admins", async () => {
    await seedUserWithRoleAndKey("viewer", "moderation-viewer-key");

    const res = await client
      .post("/api/v1/admin/notifications/moderation")
      .set("Authorization", "Bearer moderation-viewer-key")
      .send({ title: "Hello", message: "World", userIds: [1] });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("rejects an empty title or message", async () => {
    await seedUserWithRoleAndKey("admin", "moderation-empty-key");

    const res = await client
      .post("/api/v1/admin/notifications/moderation")
      .set("Authorization", "Bearer moderation-empty-key")
      .send({ title: "   ", message: "World", userIds: [1] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("rejects a missing or empty userIds array", async () => {
    await seedUserWithRoleAndKey("admin", "moderation-nouserids-key");

    const missing = await client
      .post("/api/v1/admin/notifications/moderation")
      .set("Authorization", "Bearer moderation-nouserids-key")
      .send({ title: "Hello", message: "World" });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("invalid_body");

    const empty = await client
      .post("/api/v1/admin/notifications/moderation")
      .set("Authorization", "Bearer moderation-nouserids-key")
      .send({ title: "Hello", message: "World", userIds: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe("invalid_body");
  });

  test("notifies only the specified users", async () => {
    await seedUserWithRoleAndKey("admin", "moderation-admin-key");
    const userA = await seedUserWithRoleAndKey("viewer", "moderation-user-a-key");
    const userB = await seedUserWithRoleAndKey("viewer", "moderation-user-b-key");
    const userC = await seedUserWithRoleAndKey("viewer", "moderation-user-c-key");

    const res = await client
      .post("/api/v1/admin/notifications/moderation")
      .set("Authorization", "Bearer moderation-admin-key")
      .send({
        title: "Content Warning",
        message: "Your upload was flagged for review.",
        userIds: [userA.id, userB.id],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.notifiedCount).toBe(2);

    for (const user of [userA, userB]) {
      const rows = await queryRows("SELECT * FROM NOTIFICATIONS WHERE user_id = :userId", {
        userId: user.id,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe("Content Warning");
      expect(rows[0].message).toBe("Your upload was flagged for review.");
    }

    const untouched = await queryRows("SELECT * FROM NOTIFICATIONS WHERE user_id = :userId", {
      userId: userC.id,
    });
    expect(untouched).toHaveLength(0);
  });

  test("ignores nonexistent user ids without failing the request", async () => {
    await seedUserWithRoleAndKey("admin", "moderation-ghost-key");
    const userA = await seedUserWithRoleAndKey("viewer", "moderation-ghost-user-key");

    const res = await client
      .post("/api/v1/admin/notifications/moderation")
      .set("Authorization", "Bearer moderation-ghost-key")
      .send({ title: "Hello", message: "World", userIds: [userA.id, 9_999_999] });

    expect(res.status).toBe(200);
    expect(res.body.notifiedCount).toBe(1);
  });
});
