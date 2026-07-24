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
  resetTables,
  seedSystemConfig,
  seedUser,
  seedUserApiKey,
  setupSchema,
} from "../helpers/db.js";

/**
 * Seeds a user with the given role name and an API key for Bearer auth.
 *
 * @param {string} roleName Role name (`admin`, `viewer`, …).
 * @param {string} rawKey Plaintext API key for Authorization headers.
 * @returns {Promise<{id: number} & Record<string, unknown>>} Seeded user record.
 */
async function seedUserWithRoleAndKey(roleName, rawKey) {
  const role = await Role.findOne({ where: { name: roleName } });
  const user = await seedUser({
    roleId: role?.id ?? null,
    emailVerified: true,
  });
  await seedUserApiKey(user.id, rawKey);
  return user;
}

describe("admin system config routes", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("rejects unauthenticated list", async () => {
    const client = createTestClient();
    const res = await client.get("/api/v1/admin/config");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("rejects non-admin list", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_viewer_config_001";
    await seedUserWithRoleAndKey("viewer", rawKey);

    const res = await client
      .get("/api/v1/admin/config")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("admin lists, gets, upserts, and deletes config", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_admin_config_001";
    await seedUserWithRoleAndKey("admin", rawKey);
    const auth = { Authorization: `Bearer ${rawKey}` };

    const empty = await client.get("/api/v1/admin/config").set(auth);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);

    const create = await client
      .put("/api/v1/admin/config/site_name")
      .set(auth)
      .send({ value: "JustinTube" });
    expect(create.status).toBe(200);
    expect(create.body).toMatchObject({
      name: "site_name",
      value: "JustinTube",
    });
    expect(typeof create.body.id).toBe("number");

    const list = await client.get("/api/v1/admin/config").set(auth);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].name).toBe("site_name");

    const get = await client
      .get("/api/v1/admin/config/site_name")
      .set(auth);
    expect(get.status).toBe(200);
    expect(get.body.value).toBe("JustinTube");

    const update = await client
      .put("/api/v1/admin/config/site_name")
      .set(auth)
      .send({ value: "JustinTube Prod" });
    expect(update.status).toBe(200);
    expect(update.body.value).toBe("JustinTube Prod");
    expect(update.body.id).toBe(create.body.id);

    const del = await client
      .delete("/api/v1/admin/config/site_name")
      .set(auth);
    expect(del.status).toBe(204);

    const missing = await client
      .get("/api/v1/admin/config/site_name")
      .set(auth);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("not_found");
  });

  test("admin get and delete return 404 for unknown names", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_admin_config_404";
    await seedUserWithRoleAndKey("admin", rawKey);
    const auth = { Authorization: `Bearer ${rawKey}` };

    const get = await client
      .get("/api/v1/admin/config/does_not_exist")
      .set(auth);
    expect(get.status).toBe(404);

    const del = await client
      .delete("/api/v1/admin/config/does_not_exist")
      .set(auth);
    expect(del.status).toBe(404);
  });

  test("rejects empty value on upsert", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_admin_config_empty";
    await seedUserWithRoleAndKey("admin", rawKey);

    const res = await client
      .put("/api/v1/admin/config/bad")
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ value: "   " });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("lists multiple seeded configs ordered by name", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_admin_config_list";
    await seedUserWithRoleAndKey("admin", rawKey);
    await seedSystemConfig({ name: "zeta", value: "z" });
    await seedSystemConfig({ name: "alpha", value: "a" });

    const res = await client
      .get("/api/v1/admin/config")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
    expect(res.body.map((row) => row.name)).toEqual(["alpha", "zeta"]);
  });
});
