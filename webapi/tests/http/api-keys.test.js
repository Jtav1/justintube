import {
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "@jest/globals";
import { hashPassword } from "../../lib/auth/password.js";
import { Role, UserApiKey } from "../../lib/models/index.js";
import { createTestAgent, createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedUser,
  seedUserApiKey,
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

describe("me / api-keys routes", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("unauthenticated list returns 401", async () => {
    const client = createTestClient();
    const res = await client.get("/api/v1/me/api-keys");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("create returns plaintext key once; list returns masked keyDisplay only", async () => {
    const agent = createTestAgent();
    const { csrfToken } = await registerSession(agent, {
      username: "keyowner",
      email: "keyowner@example.com",
    });

    const create = await agent
      .post("/api/v1/me/api-keys")
      .set("X-CSRF-Token", csrfToken)
      .send({ name: "ci-bot", description: "CI access" });

    expect(create.status).toBe(201);
    expect(create.body.name).toBe("ci-bot");
    expect(create.body.description).toBe("CI access");
    expect(typeof create.body.key).toBe("string");
    expect(create.body.key.startsWith("jt_")).toBe(true);
    expect(create.body.keyDisplay).toContain("*");
    expect(create.body.keyHash).toBeUndefined();
    expect(create.body.keyPrefix).toBeUndefined();

    const list = await agent.get("/api/v1/me/api-keys");
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].key).toBeUndefined();
    expect(list.body.items[0].keyHash).toBeUndefined();
    expect(list.body.items[0].keyDisplay.startsWith(create.body.key.slice(0, 8))).toBe(
      true,
    );
    expect(list.body.items[0].keyDisplay).toContain("*");
  });

  test("list only returns the caller's keys", async () => {
    const alice = await seedUser({
      username: "alice_keys",
      email: "alice_keys@example.com",
    });
    const bob = await seedUser({
      username: "bob_keys",
      email: "bob_keys@example.com",
    });
    await seedUserApiKey(alice.id, "jt_alice_only_key_001");
    await seedUserApiKey(bob.id, "jt_bob_only_key_00001");

    const client = createTestClient();
    const res = await client
      .get("/api/v1/me/api-keys")
      .set("Authorization", "Bearer jt_alice_only_key_001");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].userId).toBe(alice.id);
    expect(res.body.items[0].keyDisplay).toContain("*");
  });

  test("update changes name, description, and expiresAt; other user gets 404", async () => {
    const owner = await seedUser({
      username: "owner_upd",
      email: "owner_upd@example.com",
    });
    const other = await seedUser({
      username: "other_upd",
      email: "other_upd@example.com",
    });
    const owned = await seedUserApiKey(owner.id, "jt_owner_update_key_01");
    await seedUserApiKey(other.id, "jt_other_update_key_01");

    const future = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const client = createTestClient();

    const updated = await client
      .patch(`/api/v1/me/api-keys/${owned.id}`)
      .set("Authorization", "Bearer jt_owner_update_key_01")
      .send({
        name: "renamed",
        description: "updated desc",
        expiresAt: future,
      });

    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe("renamed");
    expect(updated.body.description).toBe("updated desc");
    expect(new Date(updated.body.expiresAt).toISOString()).toBe(future);
    expect(updated.body.key).toBeUndefined();

    const forbidden = await client
      .patch(`/api/v1/me/api-keys/${owned.id}`)
      .set("Authorization", "Bearer jt_other_update_key_01")
      .send({ name: "stolen" });

    expect(forbidden.status).toBe(404);
    expect(forbidden.body.error).toBe("not_found");
  });

  test("revoke soft-deletes key and Bearer auth stops working", async () => {
    const user = await seedUser({
      username: "revoker",
      email: "revoker@example.com",
    });
    const seeded = await seedUserApiKey(user.id, "jt_revoke_me_key_00001");
    const client = createTestClient();

    const before = await client
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer jt_revoke_me_key_00001");
    expect(before.status).toBe(200);

    const revoke = await client
      .delete(`/api/v1/me/api-keys/${seeded.id}`)
      .set("Authorization", "Bearer jt_revoke_me_key_00001");
    expect(revoke.status).toBe(200);
    expect(revoke.body).toEqual({ success: true });

    const row = await UserApiKey.findByPk(seeded.id);
    expect(row.revokedAt).not.toBeNull();

    const after = await client
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer jt_revoke_me_key_00001");
    expect(after.status).toBe(401);
  });

  test("create rejects past expiresAt", async () => {
    const agent = createTestAgent();
    const { csrfToken } = await registerSession(agent, {
      username: "past_exp",
      email: "past_exp@example.com",
    });

    const res = await agent
      .post("/api/v1/me/api-keys")
      .set("X-CSRF-Token", csrfToken)
      .send({
        name: "expired-on-create",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });
});

describe("admin / api-keys routes", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  /**
   * Seeds an admin user with a known password and logs them in.
   *
   * @returns {Promise<{
   *   agent: import('supertest').SuperAgentTest,
   *   csrfToken: string,
   *   admin: { id: number } & Record<string, unknown>
   * }>} Admin session context.
   */
  async function loginAsAdmin() {
    const adminRole = await Role.findOne({ where: { name: "admin" } });
    expect(adminRole).not.toBeNull();
    const passwordHash = await hashPassword("adminpass123");
    const admin = await seedUser({
      username: "siteadmin",
      email: "siteadmin@example.com",
      passwordHash,
      emailVerified: true,
      roleId: adminRole.id,
    });
    const agent = createTestAgent();
    const csrfToken = await loginSession(agent, {
      username: "siteadmin",
      password: "adminpass123",
    });
    return { agent, csrfToken, admin };
  }

  test("non-admin cannot list or revoke via admin routes", async () => {
    const viewer = await seedUser({
      username: "notadmin",
      email: "notadmin@example.com",
    });
    const key = await seedUserApiKey(viewer.id, "jt_viewer_admin_deny_01");
    const client = createTestClient();

    const list = await client
      .get("/api/v1/admin/api-keys")
      .set("Authorization", "Bearer jt_viewer_admin_deny_01");
    expect(list.status).toBe(403);
    expect(list.body.error).toBe("forbidden");

    const revoke = await client
      .delete(`/api/v1/admin/api-keys/${key.id}`)
      .set("Authorization", "Bearer jt_viewer_admin_deny_01");
    expect(revoke.status).toBe(403);
  });

  test("admin lists all keys with masked keyDisplay and username", async () => {
    const alice = await seedUser({
      username: "alice_admin_list",
      email: "alice_admin_list@example.com",
    });
    const bob = await seedUser({
      username: "bob_admin_list",
      email: "bob_admin_list@example.com",
    });
    await seedUserApiKey(alice.id, "jt_alice_admin_list_01");
    await seedUserApiKey(bob.id, "jt_bob_admin_list_0001");

    const { agent } = await loginAsAdmin();
    const res = await agent.get("/api/v1/admin/api-keys");

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(2);
    for (const item of res.body.items) {
      expect(item.key).toBeUndefined();
      expect(item.keyHash).toBeUndefined();
      expect(item.keyDisplay).toContain("*");
      expect(typeof item.username).toBe("string");
    }

    const usernames = res.body.items.map((item) => item.username);
    expect(usernames).toEqual(
      expect.arrayContaining(["alice_admin_list", "bob_admin_list"]),
    );
  });

  test("admin can filter by userId and revoke another user's key", async () => {
    const victim = await seedUser({
      username: "victim_keys",
      email: "victim_keys@example.com",
    });
    const other = await seedUser({
      username: "other_keys",
      email: "other_keys@example.com",
    });
    const victimKey = await seedUserApiKey(victim.id, "jt_victim_key_to_kill");
    await seedUserApiKey(other.id, "jt_other_key_keep_alive");

    const { agent, csrfToken } = await loginAsAdmin();

    const filtered = await agent.get(
      `/api/v1/admin/api-keys?userId=${victim.id}`,
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.items[0].userId).toBe(victim.id);
    expect(filtered.body.items[0].username).toBe("victim_keys");
    expect(filtered.body.items[0].keyDisplay.startsWith("jt_victi")).toBe(true);

    const before = await createTestClient()
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer jt_victim_key_to_kill");
    expect(before.status).toBe(200);

    const revoke = await agent
      .delete(`/api/v1/admin/api-keys/${victimKey.id}`)
      .set("X-CSRF-Token", csrfToken);
    expect(revoke.status).toBe(200);
    expect(revoke.body).toEqual({ success: true });

    const after = await createTestClient()
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer jt_victim_key_to_kill");
    expect(after.status).toBe(401);

    const row = await UserApiKey.findByPk(victimKey.id);
    expect(row.revokedAt).not.toBeNull();
  });
});
