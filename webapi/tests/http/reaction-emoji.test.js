import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { DEFAULT_REACTION_EMOJI, recordEmojiUse } from "../../lib/cast/emoji-usage.js";
import { Role } from "../../lib/models/index.js";
import { createTestClient } from "../helpers/app.js";
import { resetTables, seedUser, seedUserApiKey, setupSchema } from "../helpers/db.js";

/**
 * Seeds a user with the given role name and an API key for Bearer auth,
 * mirroring the identical helper in tests/http/cast.test.js.
 *
 * @param {string} roleName Role name (`admin`, `viewer`, `moderator`, …).
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
 * HTTP contract tests for GET /reaction-emoji, the usage-ranked emoji list
 * behind the CAST reaction bar.
 */
describe("GET /reaction-emoji (listReactionEmoji)", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("401s without authentication", async () => {
    const res = await client.get("/api/v1/reaction-emoji");
    expect(res.status).toBe(401);
  });

  test("returns the default six when nothing has been used", async () => {
    await seedUserWithRoleAndKey("viewer", "emoji-key-1");

    const res = await client
      .get("/api/v1/reaction-emoji")
      .set("Authorization", "Bearer emoji-key-1");

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual(DEFAULT_REACTION_EMOJI);
  });

  test("ranks by recorded usage, highest first", async () => {
    await seedUserWithRoleAndKey("viewer", "emoji-key-2");
    await recordEmojiUse("🔥");
    await recordEmojiUse("🔥");
    await recordEmojiUse("🎯");

    const res = await client
      .get("/api/v1/reaction-emoji")
      .set("Authorization", "Bearer emoji-key-2");

    expect(res.status).toBe(200);
    expect(res.body.items[0]).toBe("🔥");
    expect(res.body.items[1]).toBe("🎯");
    expect(res.body.items).toHaveLength(6);
  });

  test("respects limit", async () => {
    await seedUserWithRoleAndKey("viewer", "emoji-key-3");

    const res = await client
      .get("/api/v1/reaction-emoji?limit=3")
      .set("Authorization", "Bearer emoji-key-3");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);
  });

  test("400s on a limit outside the accepted range", async () => {
    await seedUserWithRoleAndKey("viewer", "emoji-key-4");

    for (const limit of ["0", "99", "abc"]) {
      const res = await client
        .get(`/api/v1/reaction-emoji?limit=${limit}`)
        .set("Authorization", "Bearer emoji-key-4");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_query");
    }
  });
});
