import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "@jest/globals";
import { hashPassword } from "../../lib/auth/password.js";
import { createPasswordResetToken } from "../../lib/auth/password-reset.js";
import { createCorsOptions } from "../../lib/auth/cors.js";
import { resetMailerForTests } from "../../lib/email/mailer.js";
import { PasswordResetToken, Role, User } from "../../lib/models/index.js";
import { createTestAgent, createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedEmailVerificationToken,
  seedPasswordResetToken,
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

describe("auth routes", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("rejects login without CSRF token", async () => {
    const agent = createTestAgent();
    const res = await agent
      .post("/api/v1/auth/login")
      .send({ username: "nobody", password: "password123" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("csrf_invalid");
  });

  test("register, me, logout, me 401 (cookie + CSRF)", async () => {
    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);

    const register = await agent
      .post("/api/v1/auth/register")
      .set("X-CSRF-Token", csrf)
      .send({
        username: "alice",
        email: "alice@example.com",
        password: "password123",
        displayName: "Alice",
      });

    expect(register.status).toBe(201);
    expect(register.body.user).toMatchObject({
      username: "alice",
      email: "alice@example.com",
      displayName: "Alice",
      role: "viewer",
    });
    expect(register.body.user.passwordHash).toBeUndefined();
    expect(typeof register.body.csrfToken).toBe("string");

    const me = await agent.get("/api/v1/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.username).toBe("alice");

    const logout = await agent
      .post("/api/v1/auth/logout")
      .set("X-CSRF-Token", register.body.csrfToken);
    expect(logout.status).toBe(200);
    expect(logout.body).toEqual({ success: true });

    const meAfter = await agent.get("/api/v1/auth/me");
    expect(meAfter.status).toBe(401);
  });

  test("rejects logout without a session", async () => {
    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const res = await agent
      .post("/api/v1/auth/logout")
      .set("X-CSRF-Token", csrf);

    expect(res.status).toBe(401);
  });

  test("login rotates CSRF token and authenticates", async () => {
    const passwordHash = await hashPassword("password123");
    await seedUser({
      username: "bob",
      email: "bob@example.com",
      passwordHash,
      emailVerified: true,
    });

    const agent = createTestAgent();
    const csrfBefore = await fetchCsrf(agent);

    const login = await agent
      .post("/api/v1/auth/login")
      .set("X-CSRF-Token", csrfBefore)
      .send({ username: "bob", password: "password123" });

    expect(login.status).toBe(200);
    expect(login.body.user.username).toBe("bob");
    expect(login.body.csrfToken).not.toBe(csrfBefore);

    const me = await agent.get("/api/v1/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.username).toBe("bob");
  });

  test("rejects bad login credentials", async () => {
    const passwordHash = await hashPassword("password123");
    await seedUser({
      username: "carol",
      email: "carol@example.com",
      passwordHash,
    });

    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const res = await agent
      .post("/api/v1/auth/login")
      .set("X-CSRF-Token", csrf)
      .send({ username: "carol", password: "wrong-password" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_credentials");
  });

  test("rejects duplicate registration", async () => {
    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);

    const first = await agent
      .post("/api/v1/auth/register")
      .set("X-CSRF-Token", csrf)
      .send({
        username: "dave",
        email: "dave@example.com",
        password: "password123",
      });
    expect(first.status).toBe(201);

    const csrf2 = first.body.csrfToken;
    const second = await agent
      .post("/api/v1/auth/register")
      .set("X-CSRF-Token", csrf2)
      .send({
        username: "dave",
        email: "other@example.com",
        password: "password123",
      });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("conflict");
  });

  test("rejects registration with a malformed email", async () => {
    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);

    const res = await agent
      .post("/api/v1/auth/register")
      .set("X-CSRF-Token", csrf)
      .send({
        username: "frank",
        email: "not-an-email",
        password: "password123",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("registration disabled returns 403", async () => {
    const previous = process.env.ENABLE_ACCOUNT_REGISTRATION;
    process.env.ENABLE_ACCOUNT_REGISTRATION = "false";
    try {
      const agent = createTestAgent();
      const csrf = await fetchCsrf(agent);
      const res = await agent
        .post("/api/v1/auth/register")
        .set("X-CSRF-Token", csrf)
        .send({
          username: "erin",
          email: "erin@example.com",
          password: "password123",
        });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("registration_disabled");
    } finally {
      process.env.ENABLE_ACCOUNT_REGISTRATION = previous;
    }
  });

  test("API key authenticates GET /auth/me", async () => {
    const client = createTestClient();
    const user = await seedUser({
      username: "frank",
      email: "frank@example.com",
      emailVerified: true,
    });
    const rawKey = "jt_test_api_key_frank_001";
    await seedUserApiKey(user.id, rawKey);

    const res = await client
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
    expect(res.body.username).toBe("frank");
  });

  test("expired API key is rejected", async () => {
    const client = createTestClient();
    const user = await seedUser({
      username: "gina",
      email: "gina@example.com",
    });
    const rawKey = "jt_test_api_key_gina_expired";
    await seedUserApiKey(user.id, rawKey, {
      expiresAt: new Date(Date.now() - 60_000),
    });

    const res = await client
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(401);
  });

  test("revoked API key is rejected", async () => {
    const client = createTestClient();
    const user = await seedUser({
      username: "hank",
      email: "hank@example.com",
    });
    const rawKey = "jt_test_api_key_hank_revoked";
    await seedUserApiKey(user.id, rawKey, {
      revokedAt: new Date(),
    });

    const res = await client
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(401);
  });

  test("bad API key is rejected", async () => {
    const client = createTestClient();
    const res = await client
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer totally-invalid-key");
    expect(res.status).toBe(401);
  });
});

describe("auth verify-email", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("verifies email with a valid token without changing the user's role", async () => {
    const user = await seedUser({ emailVerified: false });
    const { rawToken } = await seedEmailVerificationToken(user.id);

    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const res = await agent
      .post("/api/v1/auth/verify-email")
      .set("X-CSRF-Token", csrf)
      .send({ token: rawToken });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      id: user.id,
      emailVerified: true,
      // seedUser defaults to the "viewer" role; verification must not touch it.
      role: "viewer",
    });
  });

  test("verification is independent of role — a moderator can be unverified, then verified", async () => {
    const moderatorRole = await Role.findOne({ where: { name: "moderator" } });
    const user = await seedUser({
      emailVerified: false,
      roleId: moderatorRole.id,
    });
    const { rawToken } = await seedEmailVerificationToken(user.id);

    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const res = await agent
      .post("/api/v1/auth/verify-email")
      .set("X-CSRF-Token", csrf)
      .send({ token: rawToken });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      id: user.id,
      emailVerified: true,
      role: "moderator",
    });
  });

  test("rejects invalid verification token", async () => {
    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const res = await agent
      .post("/api/v1/auth/verify-email")
      .set("X-CSRF-Token", csrf)
      .send({ token: "not-a-real-token" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_token");
  });

  test("rejects expired verification token", async () => {
    const user = await seedUser({ emailVerified: false });
    const { rawToken } = await seedEmailVerificationToken(user.id, {
      expiresAt: new Date(Date.now() - 60_000),
    });

    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const res = await agent
      .post("/api/v1/auth/verify-email")
      .set("X-CSRF-Token", csrf)
      .send({ token: rawToken });

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("token_expired");
  });

  test("returns 409 when email is already verified", async () => {
    const user = await seedUser({ emailVerified: true });
    const { rawToken } = await seedEmailVerificationToken(user.id);

    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const res = await agent
      .post("/api/v1/auth/verify-email")
      .set("X-CSRF-Token", csrf)
      .send({ token: rawToken });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_verified");
  });

  test("verifying email still succeeds when admin new-user notifications are enabled", async () => {
    process.env.SMTP_HOST = "smtp.test";
    process.env.MAIL_FROM_ADDRESS = "noreply@test.example";
    process.env.ENABLE_ADMIN_NEW_USER_NOTIFICATIONS = "true";
    resetMailerForTests();

    try {
      const adminRole = await Role.findOne({ where: { name: "admin" } });
      await seedUser({
        roleId: adminRole.id,
        email: "admin@example.com",
        emailVerified: true,
      });

      const user = await seedUser({ emailVerified: false });
      const { rawToken } = await seedEmailVerificationToken(user.id);

      const agent = createTestAgent();
      const csrf = await fetchCsrf(agent);
      const res = await agent
        .post("/api/v1/auth/verify-email")
        .set("X-CSRF-Token", csrf)
        .send({ token: rawToken });

      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ id: user.id, emailVerified: true });
    } finally {
      delete process.env.SMTP_HOST;
      delete process.env.MAIL_FROM_ADDRESS;
      delete process.env.ENABLE_ADMIN_NEW_USER_NOTIFICATIONS;
      resetMailerForTests();
    }
  });
});

describe("auth resend-verification", () => {
  beforeAll(async () => {
    delete process.env.SMTP_HOST;
    delete process.env.MAIL_FROM_ADDRESS;
    await setupSchema();
  });

  afterEach(async () => {
    delete process.env.SMTP_HOST;
    delete process.env.MAIL_FROM_ADDRESS;
    resetMailerForTests();
    await resetTables();
  });

  test("returns 503 when email is disabled", async () => {
    const seeded = await seedUser({ emailVerified: false });
    const passwordHash = await hashPassword("password123");
    await User.update({ passwordHash }, { where: { id: seeded.id } });

    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    await agent
      .post("/api/v1/auth/login")
      .set("X-CSRF-Token", csrf)
      .send({ username: seeded.username, password: "password123" });

    const loginCsrf = (await agent.get("/api/v1/auth/csrf")).body.csrfToken;
    const res = await agent
      .post("/api/v1/auth/resend-verification")
      .set("X-CSRF-Token", loginCsrf);

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("email_disabled");
  });

  test("returns 403 when email is already verified", async () => {
    process.env.SMTP_HOST = "smtp.test";
    process.env.MAIL_FROM_ADDRESS = "noreply@test.example";
    const passwordHash = await hashPassword("password123");
    const user = await seedUser({
      emailVerified: true,
      passwordHash,
    });

    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    await agent
      .post("/api/v1/auth/login")
      .set("X-CSRF-Token", csrf)
      .send({ username: user.username, password: "password123" });

    const loginCsrf = (await agent.get("/api/v1/auth/csrf")).body.csrfToken;
    const res = await agent
      .post("/api/v1/auth/resend-verification")
      .set("X-CSRF-Token", loginCsrf);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("already_verified");
  });

  test("sends verification email when configured", async () => {
    process.env.SMTP_HOST = "smtp.test";
    process.env.MAIL_FROM_ADDRESS = "noreply@test.example";
    resetMailerForTests();

    const passwordHash = await hashPassword("password123");
    const user = await seedUser({
      emailVerified: false,
      passwordHash,
    });

    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    await agent
      .post("/api/v1/auth/login")
      .set("X-CSRF-Token", csrf)
      .send({ username: user.username, password: "password123" });

    const loginCsrf = (await agent.get("/api/v1/auth/csrf")).body.csrfToken;
    const res = await agent
      .post("/api/v1/auth/resend-verification")
      .set("X-CSRF-Token", loginCsrf);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });
});

describe("auth forgot-password", () => {
  beforeAll(async () => {
    delete process.env.SMTP_HOST;
    delete process.env.MAIL_FROM_ADDRESS;
    await setupSchema();
  });

  afterEach(async () => {
    delete process.env.SMTP_HOST;
    delete process.env.MAIL_FROM_ADDRESS;
    resetMailerForTests();
    await resetTables();
  });

  test("returns 400 when username is missing", async () => {
    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const res = await agent
      .post("/api/v1/auth/forgot-password")
      .set("X-CSRF-Token", csrf)
      .send({ email: "someone@example.com" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("returns 400 when email is missing", async () => {
    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const res = await agent
      .post("/api/v1/auth/forgot-password")
      .set("X-CSRF-Token", csrf)
      .send({ username: "someone" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("creates a reset token when username and email match one account", async () => {
    process.env.SMTP_HOST = "smtp.test";
    process.env.MAIL_FROM_ADDRESS = "noreply@test.example";
    resetMailerForTests();

    const user = await seedUser({
      username: "ivan",
      email: "ivan@example.com",
    });

    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const res = await agent
      .post("/api/v1/auth/forgot-password")
      .set("X-CSRF-Token", csrf)
      .send({ username: "ivan", email: "ivan@example.com" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    const token = await PasswordResetToken.findOne({ where: { userId: user.id } });
    expect(token).not.toBeNull();
  });

  test("returns 200 without creating a token when no account matches", async () => {
    process.env.SMTP_HOST = "smtp.test";
    process.env.MAIL_FROM_ADDRESS = "noreply@test.example";
    resetMailerForTests();

    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const res = await agent
      .post("/api/v1/auth/forgot-password")
      .set("X-CSRF-Token", csrf)
      .send({ username: "nobody-here", email: "nobody@example.com" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    const count = await PasswordResetToken.count();
    expect(count).toBe(0);
  });

  test("returns 200 without creating a token when username and email belong to different accounts", async () => {
    process.env.SMTP_HOST = "smtp.test";
    process.env.MAIL_FROM_ADDRESS = "noreply@test.example";
    resetMailerForTests();

    await seedUser({ username: "judy", email: "judy@example.com" });
    await seedUser({ username: "kevin", email: "kevin@example.com" });

    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const res = await agent
      .post("/api/v1/auth/forgot-password")
      .set("X-CSRF-Token", csrf)
      .send({ username: "judy", email: "kevin@example.com" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    const count = await PasswordResetToken.count();
    expect(count).toBe(0);
  });

  test("returns 200 without creating a token when email is not configured", async () => {
    const user = await seedUser({
      username: "laura",
      email: "laura@example.com",
    });

    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const res = await agent
      .post("/api/v1/auth/forgot-password")
      .set("X-CSRF-Token", csrf)
      .send({ username: "laura", email: "laura@example.com" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    const token = await PasswordResetToken.findOne({ where: { userId: user.id } });
    expect(token).toBeNull();
  });
});

describe("auth reset-password", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("returns 400 when token is missing", async () => {
    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const res = await agent
      .post("/api/v1/auth/reset-password")
      .set("X-CSRF-Token", csrf)
      .send({ newPassword: "newpassword456" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("returns 400 when newPassword is missing", async () => {
    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const res = await agent
      .post("/api/v1/auth/reset-password")
      .set("X-CSRF-Token", csrf)
      .send({ token: "irrelevant" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("returns 400 when newPassword is too short", async () => {
    const user = await seedUser({ passwordHash: await hashPassword("password123") });
    const { rawToken } = await seedPasswordResetToken(user.id);

    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const res = await agent
      .post("/api/v1/auth/reset-password")
      .set("X-CSRF-Token", csrf)
      .send({ token: rawToken, newPassword: "short" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_password");
  });

  test("rejects an invalid reset token", async () => {
    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const res = await agent
      .post("/api/v1/auth/reset-password")
      .set("X-CSRF-Token", csrf)
      .send({ token: "not-a-real-token", newPassword: "newpassword456" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_token");
  });

  test("rejects an expired reset token", async () => {
    const user = await seedUser({ passwordHash: await hashPassword("password123") });
    const { rawToken } = await seedPasswordResetToken(user.id, {
      expiresAt: new Date(Date.now() - 60_000),
    });

    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const res = await agent
      .post("/api/v1/auth/reset-password")
      .set("X-CSRF-Token", csrf)
      .send({ token: rawToken, newPassword: "newpassword456" });

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("token_expired");
  });

  test("resets the password, clears passwordExpired, and burns the token", async () => {
    const user = await seedUser({
      passwordHash: await hashPassword("password123"),
      passwordExpired: true,
      emailVerified: true,
    });
    const { rawToken } = await seedPasswordResetToken(user.id);

    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const res = await agent
      .post("/api/v1/auth/reset-password")
      .set("X-CSRF-Token", csrf)
      .send({ token: rawToken, newPassword: "newpassword456" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    const token = await PasswordResetToken.findOne({ where: { userId: user.id } });
    expect(token).toBeNull();

    const loginCsrf = (await agent.get("/api/v1/auth/csrf")).body.csrfToken;

    const oldLogin = await agent
      .post("/api/v1/auth/login")
      .set("X-CSRF-Token", loginCsrf)
      .send({ username: user.username, password: "password123" });
    expect(oldLogin.status).toBe(401);

    const newLogin = await agent
      .post("/api/v1/auth/login")
      .set("X-CSRF-Token", loginCsrf)
      .send({ username: user.username, password: "newpassword456" });
    expect(newLogin.status).toBe(200);
    expect(newLogin.body.user.passwordExpired).toBe(false);
  });

  test("rejects reuse of an already-consumed token", async () => {
    const user = await seedUser({ passwordHash: await hashPassword("password123") });
    const { rawToken } = await seedPasswordResetToken(user.id);

    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const first = await agent
      .post("/api/v1/auth/reset-password")
      .set("X-CSRF-Token", csrf)
      .send({ token: rawToken, newPassword: "newpassword456" });
    expect(first.status).toBe(200);

    const csrf2 = (await agent.get("/api/v1/auth/csrf")).body.csrfToken;
    const second = await agent
      .post("/api/v1/auth/reset-password")
      .set("X-CSRF-Token", csrf2)
      .send({ token: rawToken, newPassword: "anotherpassword789" });
    expect(second.status).toBe(400);
    expect(second.body.error).toBe("invalid_token");
  });

  test("requesting a new token invalidates the previous one", async () => {
    const user = await seedUser({ passwordHash: await hashPassword("password123") });
    const firstToken = await createPasswordResetToken(user.id);
    const secondToken = await createPasswordResetToken(user.id);

    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const usingFirst = await agent
      .post("/api/v1/auth/reset-password")
      .set("X-CSRF-Token", csrf)
      .send({ token: firstToken, newPassword: "newpassword456" });
    expect(usingFirst.status).toBe(400);
    expect(usingFirst.body.error).toBe("invalid_token");

    const csrf2 = (await agent.get("/api/v1/auth/csrf")).body.csrfToken;
    const usingSecond = await agent
      .post("/api/v1/auth/reset-password")
      .set("X-CSRF-Token", csrf2)
      .send({ token: secondToken, newPassword: "newpassword456" });
    expect(usingSecond.status).toBe(200);
  });
});

describe("auth change password", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("changes password for session-authenticated user", async () => {
    const passwordHash = await hashPassword("password123");
    const user = await seedUser({ passwordHash, emailVerified: true });

    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const login = await agent
      .post("/api/v1/auth/login")
      .set("X-CSRF-Token", csrf)
      .send({ username: user.username, password: "password123" });
    expect(login.status).toBe(200);

    const change = await agent
      .post("/api/v1/auth/password")
      .set("X-CSRF-Token", login.body.csrfToken)
      .send({
        currentPassword: "password123",
        newPassword: "newpassword456",
      });
    expect(change.status).toBe(200);
    expect(change.body).toEqual({ success: true });

    await agent.post("/api/v1/auth/logout").set("X-CSRF-Token", login.body.csrfToken);

    const csrf2 = await fetchCsrf(agent);
    const relogin = await agent
      .post("/api/v1/auth/login")
      .set("X-CSRF-Token", csrf2)
      .send({ username: user.username, password: "newpassword456" });
    expect(relogin.status).toBe(200);
  });

  test("rejects wrong current password", async () => {
    const passwordHash = await hashPassword("password123");
    const user = await seedUser({ passwordHash, emailVerified: true });

    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const login = await agent
      .post("/api/v1/auth/login")
      .set("X-CSRF-Token", csrf)
      .send({ username: user.username, password: "password123" });

    const res = await agent
      .post("/api/v1/auth/password")
      .set("X-CSRF-Token", login.body.csrfToken)
      .send({
        currentPassword: "wrong-password",
        newPassword: "newpassword456",
      });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_credentials");
  });

  test("rejects API key authentication", async () => {
    const client = createTestClient();
    const user = await seedUser({
      passwordHash: await hashPassword("password123"),
      emailVerified: true,
    });
    const rawKey = "jt_test_api_key_password_change";
    await seedUserApiKey(user.id, rawKey);

    const res = await client
      .post("/api/v1/auth/password")
      .set("Authorization", `Bearer ${rawKey}`)
      .send({
        currentPassword: "password123",
        newPassword: "newpassword456",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("session_required");
  });

  test("rejects SSO-only accounts without a password hash", async () => {
    const passwordHash = await hashPassword("password123");
    const seeded = await seedUser({
      passwordHash,
      emailVerified: true,
    });
    const user = await User.findByPk(seeded.id);

    const agent = createTestAgent();
    const csrf = await fetchCsrf(agent);
    const login = await agent
      .post("/api/v1/auth/login")
      .set("X-CSRF-Token", csrf)
      .send({ username: seeded.username, password: "password123" });
    expect(login.status).toBe(200);

    await user.update({ passwordHash: null });

    const res = await agent
      .post("/api/v1/auth/password")
      .set("X-CSRF-Token", login.body.csrfToken)
      .send({
        currentPassword: "password123",
        newPassword: "newpassword456",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("password_not_set");
  });
});

describe("createCorsOptions", () => {
  test("rejects cross-origin requests in production when CORS_ORIGIN is unset", () => {
    const opts = createCorsOptions({ nodeEnv: "production", corsOrigin: "" });
    expect(opts.origin).toBe(false);
    expect(opts.credentials).toBe(true);
  });

  test("reflects Origin outside production when CORS_ORIGIN is unset", () => {
    const opts = createCorsOptions({ nodeEnv: "development", corsOrigin: "" });
    expect(opts.origin).toBe(true);
    expect(opts.credentials).toBe(true);
  });

  test("only allows allowlisted origins when CORS_ORIGIN is set", () => {
    const opts = createCorsOptions({
      nodeEnv: "production",
      corsOrigin: "https://app.example.com, https://other.example.com",
    });
    expect(opts.credentials).toBe(true);
    expect(typeof opts.origin).toBe("function");

    let allowResult;
    opts.origin("https://app.example.com", (err, allow) => {
      allowResult = [err, allow];
    });
    expect(allowResult).toEqual([null, true]);

    let denyResult;
    opts.origin("https://evil.example.com", (err, allow) => {
      denyResult = [err, allow];
    });
    expect(denyResult[0]).toBeInstanceOf(Error);
    expect(denyResult[1]).toBeUndefined();

    let noOriginResult;
    opts.origin(undefined, (err, allow) => {
      noOriginResult = [err, allow];
    });
    expect(noOriginResult).toEqual([null, true]);
  });
});
