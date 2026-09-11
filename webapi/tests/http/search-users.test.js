import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedUser,
  seedUserApiKey,
  setupSchema,
} from "../helpers/db.js";
import { Role } from "../../lib/models/index.js";

/**
 * HTTP contract tests for GET /search/users — the recipient-picker
 * autocomplete backing the Upload page's private-share field.
 */
describe("GET /search/users", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  /**
   * Seeds a user with an API key and returns the raw key for auth headers.
   *
   * @param {object} [overrides] Passed through to seedUser.
   * @returns {Promise<{user: object, key: string}>} Seeded user and its raw API key.
   */
  async function seedAuthedUser(overrides = {}) {
    const user = await seedUser(overrides);
    const key = `jt_test_${user.id}_key`;
    await seedUserApiKey(user.id, key);
    return { user, key };
  }

  test("rejects an unauthenticated request", async () => {
    const res = await client.get("/api/v1/search/users?q=ali");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("matches a username prefix", async () => {
    const { key } = await seedAuthedUser();
    await seedUser({ username: "alice" });

    const res = await client
      .get("/api/v1/search/users?q=ali")
      .set("Authorization", `Bearer ${key}`);

    expect(res.status).toBe(200);
    expect(res.body.items.map((item) => item.username)).toContain("alice");
  });

  test("matches a displayName prefix", async () => {
    const { key } = await seedAuthedUser();
    await seedUser({ username: "someone", displayName: "Alicia Keys" });

    const res = await client
      .get("/api/v1/search/users?q=Alicia")
      .set("Authorization", `Bearer ${key}`);

    expect(res.status).toBe(200);
    expect(res.body.items.map((item) => item.username)).toContain("someone");
  });

  test("excludes a locked user", async () => {
    const { key } = await seedAuthedUser();
    const lockedRole = await Role.findOne({ where: { name: "locked" } });
    await seedUser({ username: "alicebanned", roleId: lockedRole.id });

    const res = await client
      .get("/api/v1/search/users?q=alice")
      .set("Authorization", `Bearer ${key}`);

    expect(res.status).toBe(200);
    expect(res.body.items.map((item) => item.username)).not.toContain("alicebanned");
  });

  test("returns an empty list for an empty q without querying the table", async () => {
    const { key } = await seedAuthedUser();

    const res = await client
      .get("/api/v1/search/users")
      .set("Authorization", `Bearer ${key}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  test("rejects limit=0", async () => {
    const { key } = await seedAuthedUser();
    const res = await client
      .get("/api/v1/search/users?q=a&limit=0")
      .set("Authorization", `Bearer ${key}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  test("rejects a limit above the max", async () => {
    const { key } = await seedAuthedUser();
    const res = await client
      .get("/api/v1/search/users?q=a&limit=999")
      .set("Authorization", `Bearer ${key}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  test("response items expose only userId/username/displayName", async () => {
    const { key } = await seedAuthedUser();
    await seedUser({ username: "alice" });

    const res = await client
      .get("/api/v1/search/users?q=ali")
      .set("Authorization", `Bearer ${key}`);

    expect(res.status).toBe(200);
    const item = res.body.items.find((entry) => entry.username === "alice");
    expect(item).toBeDefined();
    expect(Object.keys(item).sort()).toEqual(["displayName", "userId", "username"]);
  });
});
