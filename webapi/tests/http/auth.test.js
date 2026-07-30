import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "@jest/globals";
import { hashPassword } from "../../lib/auth/password.js";
import { createCorsOptions } from "../../lib/auth/cors.js";
import { resetMailerForTests } from "../../lib/email/mailer.js";
import { Role, User } from "../../lib/models/index.js";
import { createTestAgent, createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedEmailVerificationToken,
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
  test("reflects Origin and allows credentials regardless of environment", () => {
    const opts = createCorsOptions({
      nodeEnv: "production",
      corsOrigin: "",
    });
    expect(opts.origin).toBe(true);
    expect(opts.credentials).toBe(true);
  });
});
