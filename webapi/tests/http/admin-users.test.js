import {
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "@jest/globals";
import { hashPassword, verifyPassword } from "../../lib/auth/password.js";
import { resetMailerForTests } from "../../lib/email/mailer.js";
import { Role, User } from "../../lib/models/index.js";
import { createTestAgent, createTestClient } from "../helpers/app.js";
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

describe("adminResetUserPassword", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("rejects unauthenticated reset", async () => {
    const client = createTestClient();
    const target = await seedUser({
      passwordHash: await hashPassword("oldpassword1"),
    });

    const res = await client
      .post(`/api/v1/admin/users/${target.id}/password`)
      .set("Authorization", "Bearer jt_not_a_real_key")
      .send({ newPassword: "temporary1" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("rejects non-admin reset", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_viewer_reset_pw_001";
    await seedUserWithRoleAndKey("viewer", rawKey);
    const target = await seedUser({
      passwordHash: await hashPassword("oldpassword1"),
    });

    const res = await client
      .post(`/api/v1/admin/users/${target.id}/password`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ newPassword: "temporary1" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("admin resets password and marks it expired", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_admin_reset_pw_001";
    await seedUserWithRoleAndKey("admin", rawKey);
    const target = await seedUser({
      username: "target_user",
      passwordHash: await hashPassword("oldpassword1"),
      passwordExpired: false,
    });

    const res = await client
      .post(`/api/v1/admin/users/${target.id}/password`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ newPassword: "temporary1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    const updated = await User.findByPk(target.id);
    expect(updated.passwordExpired).toBe(true);
    expect(await verifyPassword("temporary1", updated.passwordHash)).toBe(true);
    expect(await verifyPassword("oldpassword1", updated.passwordHash)).toBe(
      false,
    );
  });

  test("returns 404 for unknown user id", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_admin_reset_pw_404";
    await seedUserWithRoleAndKey("admin", rawKey);

    const res = await client
      .post("/api/v1/admin/users/999999/password")
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ newPassword: "temporary1" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("rejects short passwords", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_admin_reset_pw_short";
    await seedUserWithRoleAndKey("admin", rawKey);
    const target = await seedUser({
      passwordHash: await hashPassword("oldpassword1"),
    });

    const res = await client
      .post(`/api/v1/admin/users/${target.id}/password`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ newPassword: "short" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_password");
  });
});

describe("adminResendUserVerification", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    delete process.env.SMTP_HOST;
    delete process.env.MAIL_FROM_ADDRESS;
    resetMailerForTests();
    await resetTables();
  });

  test("rejects unauthenticated resend", async () => {
    const client = createTestClient();
    const target = await seedUser({ emailVerified: false });

    const res = await client
      .post(`/api/v1/admin/users/${target.id}/resend-verification`)
      .set("Authorization", "Bearer jt_not_a_real_key");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("rejects non-admin resend", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_viewer_resend_verify_001";
    await seedUserWithRoleAndKey("viewer", rawKey);
    const target = await seedUser({ emailVerified: false });

    const res = await client
      .post(`/api/v1/admin/users/${target.id}/resend-verification`)
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("returns 404 for unknown user id", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_admin_resend_verify_404";
    await seedUserWithRoleAndKey("admin", rawKey);

    const res = await client
      .post("/api/v1/admin/users/999999/resend-verification")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("returns 503 when email is disabled", async () => {
    delete process.env.SMTP_HOST;
    delete process.env.MAIL_FROM_ADDRESS;
    const client = createTestClient();
    const rawKey = "jt_test_admin_resend_verify_disabled";
    await seedUserWithRoleAndKey("admin", rawKey);
    const target = await seedUser({ emailVerified: false });

    const res = await client
      .post(`/api/v1/admin/users/${target.id}/resend-verification`)
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("email_disabled");
  });

  test("returns 403 when target user is already verified", async () => {
    process.env.SMTP_HOST = "smtp.test";
    process.env.MAIL_FROM_ADDRESS = "noreply@test.example";
    resetMailerForTests();
    const client = createTestClient();
    const rawKey = "jt_test_admin_resend_verify_already";
    await seedUserWithRoleAndKey("admin", rawKey);
    const target = await seedUser({ emailVerified: true });

    const res = await client
      .post(`/api/v1/admin/users/${target.id}/resend-verification`)
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("already_verified");
  });

  test("admin resends verification email for an unverified user", async () => {
    process.env.SMTP_HOST = "smtp.test";
    process.env.MAIL_FROM_ADDRESS = "noreply@test.example";
    resetMailerForTests();
    const client = createTestClient();
    const rawKey = "jt_test_admin_resend_verify_ok";
    await seedUserWithRoleAndKey("admin", rawKey);
    const target = await seedUser({ emailVerified: false });

    const res = await client
      .post(`/api/v1/admin/users/${target.id}/resend-verification`)
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });
});

describe("adminListUsers", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("rejects unauthenticated list", async () => {
    const client = createTestClient();
    const res = await client.get("/api/v1/admin/users?limit=10");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("rejects non-admin list", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_viewer_list_users_001";
    await seedUserWithRoleAndKey("viewer", rawKey);

    const res = await client
      .get("/api/v1/admin/users?limit=10")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("requires limit query param", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_admin_list_users_nolimit";
    await seedUserWithRoleAndKey("admin", rawKey);

    const res = await client
      .get("/api/v1/admin/users")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  test("lists users paginated with roles and no passwordHash", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_admin_list_users_ok";
    const admin = await seedUserWithRoleAndKey("admin", rawKey, {
      username: "admin_lister",
    });
    await seedUser({ username: "user_a" });
    await seedUser({ username: "user_b" });
    await seedUser({ username: "user_c" });

    const page1 = await client
      .get("/api/v1/admin/users?limit=2&offset=0")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(page1.status).toBe(200);
    expect(page1.body.limit).toBe(2);
    expect(page1.body.offset).toBe(0);
    expect(page1.body.total).toBeGreaterThanOrEqual(4);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.items[0]).toMatchObject({
      id: expect.any(Number),
      username: expect.any(String),
      email: expect.any(String),
      role: expect.any(String),
    });
    expect(page1.body.items[0]).toHaveProperty("createdAt");
    expect(page1.body.items[0]).toHaveProperty("updatedAt");
    expect(page1.body.items[0]).not.toHaveProperty("passwordHash");

    const page2 = await client
      .get("/api/v1/admin/users?limit=2&offset=2")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(page2.status).toBe(200);
    expect(page2.body.offset).toBe(2);
    expect(page2.body.items.length).toBeGreaterThanOrEqual(1);
    const ids = [
      ...page1.body.items.map((u) => u.id),
      ...page2.body.items.map((u) => u.id),
    ];
    expect(ids).toContain(admin.id);
  });
});

describe("adminUpdateUser", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("rejects unauthenticated update", async () => {
    const client = createTestClient();
    const target = await seedUser();
    const res = await client
      .patch(`/api/v1/admin/users/${target.id}`)
      .set("Authorization", "Bearer jt_not_a_real_key")
      .send({ displayName: "Nope" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("rejects non-admin update", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_viewer_update_user_001";
    await seedUserWithRoleAndKey("viewer", rawKey);
    const target = await seedUser();

    const res = await client
      .patch(`/api/v1/admin/users/${target.id}`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ displayName: "Nope" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("updates profile fields and role", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_admin_update_user_ok";
    await seedUserWithRoleAndKey("admin", rawKey);
    const target = await seedUser({
      username: "before_name",
      email: "before@example.com",
      displayName: "Before",
      bio: "old bio",
      emailVerified: false,
      passwordExpired: false,
      uploader: false,
    });

    const res = await client
      .patch(`/api/v1/admin/users/${target.id}`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({
        username: "after_name",
        email: "after@example.com",
        displayName: "After",
        bio: "new bio",
        emailVerified: true,
        passwordExpired: true,
        uploader: true,
        role: "moderator",
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: target.id,
      username: "after_name",
      email: "after@example.com",
      displayName: "After",
      bio: "new bio",
      emailVerified: true,
      passwordExpired: true,
      uploader: true,
      role: "moderator",
    });
    expect(res.body).not.toHaveProperty("passwordHash");

    const updated = await User.findByPk(target.id, {
      include: [{ model: Role, required: false }],
    });
    expect(updated.username).toBe("after_name");
    expect(updated.Role.name).toBe("moderator");
    expect(updated.passwordExpired).toBe(true);
  });

  test("notifies the user on an uploader grant and a role change, but not on idempotent re-saves", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_admin_update_user_notify";
    await seedUserWithRoleAndKey("admin", rawKey);
    const target = await seedUser({ uploader: false });

    const userNotifications = () =>
      queryRows("SELECT * FROM NOTIFICATIONS WHERE user_id = :userId ORDER BY id ASC", {
        userId: target.id,
      });

    // Grants uploader + changes role in one request: both fire.
    const firstRes = await client
      .patch(`/api/v1/admin/users/${target.id}`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ uploader: true, role: "moderator" });
    expect(firstRes.status).toBe(200);

    let rows = await userNotifications();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.title).sort()).toEqual(["Account Action", "Role Updated"]);
    const roleRow = rows.find((row) => row.title === "Role Updated");
    expect(roleRow.message).toBe("Your role is now: moderator");
    expect(rows.every((row) => row.target === null)).toBe(true);

    // Re-sending the same uploader:true and role:"moderator" is a no-op: no new rows.
    const secondRes = await client
      .patch(`/api/v1/admin/users/${target.id}`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ uploader: true, role: "moderator" });
    expect(secondRes.status).toBe(200);
    rows = await userNotifications();
    expect(rows).toHaveLength(2);

    // Clearing the role to null does not fire a "Role Updated" notification.
    const clearedRes = await client
      .patch(`/api/v1/admin/users/${target.id}`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ role: null });
    expect(clearedRes.status).toBe(200);
    rows = await userNotifications();
    expect(rows).toHaveLength(2);
  });

  test("rejects password fields on update", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_admin_update_user_pw";
    await seedUserWithRoleAndKey("admin", rawKey);
    const target = await seedUser();

    const res = await client
      .patch(`/api/v1/admin/users/${target.id}`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ newPassword: "shouldfail1" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("returns 404 for unknown user id", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_admin_update_user_404";
    await seedUserWithRoleAndKey("admin", rawKey);

    const res = await client
      .patch("/api/v1/admin/users/999999")
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ displayName: "Ghost" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("returns 409 on username conflict", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_admin_update_user_409";
    await seedUserWithRoleAndKey("admin", rawKey);
    await seedUser({ username: "taken_name", email: "taken@example.com" });
    const target = await seedUser({
      username: "free_name",
      email: "free@example.com",
    });

    const res = await client
      .patch(`/api/v1/admin/users/${target.id}`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ username: "taken_name" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("conflict");
  });
});

describe("login passwordExpired status", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  /**
   * Fetches a CSRF token for a cookie-jar agent.
   *
   * @param {import('supertest').SuperAgentTest} agent Cookie-jar agent.
   * @returns {Promise<string>} CSRF token string.
   */
  async function fetchCsrf(agent) {
    const res = await agent.get("/api/v1/auth/csrf");
    expect(res.status).toBe(200);
    return res.body.csrfToken;
  }

  test("login includes passwordExpired false by default", async () => {
    const passwordHash = await hashPassword("password123");
    await seedUser({
      username: "login_fresh",
      email: "login_fresh@example.com",
      passwordHash,
      emailVerified: true,
    });

    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const login = await agent
      .post("/api/v1/auth/login")
      .set("X-CSRF-Token", csrf)
      .send({ username: "login_fresh", password: "password123" });

    expect(login.status).toBe(200);
    expect(login.body.user.passwordExpired).toBe(false);
  });

  test("login includes passwordExpired true after admin reset", async () => {
    const passwordHash = await hashPassword("temporary1");
    await seedUser({
      username: "login_expired",
      email: "login_expired@example.com",
      passwordHash,
      passwordExpired: true,
      emailVerified: true,
    });

    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const login = await agent
      .post("/api/v1/auth/login")
      .set("X-CSRF-Token", csrf)
      .send({ username: "login_expired", password: "temporary1" });

    expect(login.status).toBe(200);
    expect(login.body.user.passwordExpired).toBe(true);
  });

  test("changing password clears passwordExpired", async () => {
    const passwordHash = await hashPassword("temporary1");
    const seeded = await seedUser({
      username: "clear_expired",
      email: "clear_expired@example.com",
      passwordHash,
      passwordExpired: true,
      emailVerified: true,
    });

    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const login = await agent
      .post("/api/v1/auth/login")
      .set("X-CSRF-Token", csrf)
      .send({ username: "clear_expired", password: "temporary1" });
    expect(login.status).toBe(200);
    expect(login.body.user.passwordExpired).toBe(true);

    const change = await agent
      .post("/api/v1/auth/password")
      .set("X-CSRF-Token", login.body.csrfToken)
      .send({
        currentPassword: "temporary1",
        newPassword: "newpassword456",
      });
    expect(change.status).toBe(200);
    expect(change.body).toEqual({ success: true });

    const updated = await User.findByPk(seeded.id);
    expect(updated.passwordExpired).toBe(false);

    const me = await agent.get("/api/v1/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.passwordExpired).toBe(false);
  });
});
