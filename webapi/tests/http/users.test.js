import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { resolveSitedataPath } from "../../lib/sitedata-meta.js";
import { createTestAgent, createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedMetadata,
  seedSubscription,
  seedUpload,
  seedUser,
  seedUserApiKey,
  seedVideoAccess,
  setupSchema,
} from "../helpers/db.js";

const avatarsDir = resolveSitedataPath("avatars");
const bannersDir = resolveSitedataPath("banners");

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

describe("GET /users/:username/avatar", () => {
  beforeAll(async () => {
    await setupSchema();
    await mkdir(avatarsDir, { recursive: true });
  });

  afterEach(async () => {
    await resetTables();
  });

  test("returns 404 for an unknown username", async () => {
    const client = createTestClient();
    const res = await client.get("/api/v1/users/no_such_user/avatar");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("returns 404 for a known user with no avatar set", async () => {
    await seedUser({ username: "avatarless", email: "avatarless@example.com" });

    const client = createTestClient();
    const res = await client.get("/api/v1/users/avatarless/avatar");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("serves the avatar image with the correct content type, no auth required", async () => {
    const filename = "test-avatar.jpg";
    await writeFile(join(avatarsDir, filename), Buffer.from("fake-jpeg-bytes"));
    await seedUser({
      username: "avatar_owner",
      email: "avatar_owner@example.com",
      avatarFilename: filename,
    });

    const client = createTestClient();
    const res = await client.get("/api/v1/users/avatar_owner/avatar");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.body).toEqual(Buffer.from("fake-jpeg-bytes"));
  });

  test("returns 404 when the row references a file missing on disk", async () => {
    await seedUser({
      username: "avatar_missing_file",
      email: "avatar_missing_file@example.com",
      avatarFilename: "does-not-exist.png",
    });

    const client = createTestClient();
    const res = await client.get("/api/v1/users/avatar_missing_file/avatar");
    expect(res.status).toBe(404);
  });
});

describe("GET /users/:username (getUserChannel)", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("returns 404 for an unknown username", async () => {
    const client = createTestClient();
    const res = await client.get("/api/v1/users/no_such_user");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("returns 404 for a locked (banned) user", async () => {
    const locked = await seedUser({ username: "locked_channel", email: "locked_channel@example.com" });
    const { queryRows } = await import("../helpers/db.js");
    const [lockedRole] = await queryRows(
      "SELECT id FROM ROLES WHERE name = :name",
      { name: "locked" },
    );
    await queryRows("UPDATE USERS SET role_id = :roleId WHERE id = :id", {
      roleId: lockedRole.id,
      id: locked.id,
    });

    const client = createTestClient();
    const res = await client.get("/api/v1/users/locked_channel");
    expect(res.status).toBe(404);
  });

  test("returns channel profile and public videos only, newest first", async () => {
    const owner = await seedUser({
      username: "channel_owner",
      email: "channel_owner@example.com",
      displayName: "Channel Owner",
      bio: "Hello world",
      avatarFilename: "owner.jpg",
    });

    const older = await seedUpload({ userId: owner.id });
    await seedMetadata(older.id, {
      title: "Older public video",
      visibility: "public",
      createdAt: new Date(Date.now() - 60_000),
    });

    const newer = await seedUpload({ userId: owner.id });
    await seedMetadata(newer.id, { title: "Newer public video", visibility: "public" });

    const privateUpload = await seedUpload({ userId: owner.id });
    await seedMetadata(privateUpload.id, { title: "Private video", visibility: "private" });

    const unlistedUpload = await seedUpload({ userId: owner.id });
    await seedMetadata(unlistedUpload.id, { title: "Unlisted video", visibility: "unlisted" });

    const client = createTestClient();
    const res = await client.get("/api/v1/users/channel_owner");
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      id: owner.id,
      username: "channel_owner",
      displayName: "Channel Owner",
      bio: "Hello world",
      avatarFilename: "owner.jpg",
    });
    expect(res.body.videos.totalHits).toBe(2);
    expect(res.body.videos.items.map((v) => v.title)).toEqual([
      "Newer public video",
      "Older public video",
    ]);
  });

  test("hides non-public videos from the channel page even for the owner or an admin", async () => {
    const owner = await seedUser({ username: "self_owner", email: "self_owner@example.com" });
    const privateUpload = await seedUpload({ userId: owner.id });
    await seedMetadata(privateUpload.id, { title: "Private video", visibility: "private" });

    const ownerAgent = createTestAgent();
    await registerSession(ownerAgent, {
      username: "self_owner_viewer",
      email: "self_owner_viewer@example.com",
    });

    const res = await ownerAgent.get("/api/v1/users/self_owner");
    expect(res.status).toBe(200);
    expect(res.body.videos.totalHits).toBe(0);
  });
});

describe("GET /users/:username/videos (listUserVideos)", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("returns 404 for an unknown username", async () => {
    const client = createTestClient();
    const res = await client.get("/api/v1/users/no_such_user/videos");
    expect(res.status).toBe(404);
  });

  test("returns only the paginated video envelope, no user info", async () => {
    const owner = await seedUser({ username: "videos_only_owner", email: "videos_only_owner@example.com" });
    const upload = await seedUpload({ userId: owner.id });
    await seedMetadata(upload.id, { title: "Public video", visibility: "public" });

    const client = createTestClient();
    const res = await client.get("/api/v1/users/videos_only_owner/videos");
    expect(res.status).toBe(200);
    expect(res.body.user).toBeUndefined();
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toBe("Public video");
    expect(res.body).toMatchObject({ page: 1, limit: 20, totalHits: 1, totalPages: 1 });
  });

  test("rejects an invalid limit with 400 invalid_query", async () => {
    await seedUser({ username: "videos_bad_query", email: "videos_bad_query@example.com" });
    const client = createTestClient();
    const res = await client.get("/api/v1/users/videos_bad_query/videos?limit=1000");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  test("includes the owner's own unlisted/hidden videos only when authenticated as that owner", async () => {
    const owner = await seedUser({
      username: "videos_owner_self",
      email: "videos_owner_self@example.com",
    });
    await seedUserApiKey(owner.id, "jt_test_channel_owner_key");

    const publicUpload = await seedUpload({ userId: owner.id });
    await seedMetadata(publicUpload.id, { title: "Public video", visibility: "public" });
    const unlistedUpload = await seedUpload({ userId: owner.id });
    await seedMetadata(unlistedUpload.id, { title: "Unlisted video", visibility: "unlisted" });
    const hiddenUpload = await seedUpload({ userId: owner.id });
    await seedMetadata(hiddenUpload.id, { title: "Hidden video", visibility: "hidden" });

    const client = createTestClient();

    const anonRes = await client.get("/api/v1/users/videos_owner_self/videos");
    expect(anonRes.status).toBe(200);
    const anonTitles = anonRes.body.items.map((item) => item.title);
    expect(anonTitles).toEqual(["Public video"]);

    const selfRes = await client
      .get("/api/v1/users/videos_owner_self/videos")
      .set("Authorization", "Bearer jt_test_channel_owner_key");
    expect(selfRes.status).toBe(200);
    const selfTitles = selfRes.body.items.map((item) => item.title).sort();
    expect(selfTitles).toEqual(["Hidden video", "Public video", "Unlisted video"]);
  });

  test("a non-owner viewer sees public videos plus private videos they hold an access grant for", async () => {
    const owner = await seedUser({ username: "grant_owner", email: "grant_owner@example.com" });

    const publicUpload = await seedUpload({ userId: owner.id });
    await seedMetadata(publicUpload.id, { title: "Public video", visibility: "public" });

    const grantedPrivateUpload = await seedUpload({ userId: owner.id });
    await seedMetadata(grantedPrivateUpload.id, { title: "Granted private video", visibility: "private" });

    const ungrantedPrivateUpload = await seedUpload({ userId: owner.id });
    await seedMetadata(ungrantedPrivateUpload.id, { title: "Ungranted private video", visibility: "private" });

    const unlistedUpload = await seedUpload({ userId: owner.id });
    await seedMetadata(unlistedUpload.id, { title: "Unlisted video", visibility: "unlisted" });

    const hiddenUpload = await seedUpload({ userId: owner.id });
    await seedMetadata(hiddenUpload.id, { title: "Hidden video", visibility: "hidden" });

    const agent = createTestAgent();
    const { user: viewer } = await registerSession(agent, {
      username: "grant_viewer",
      email: "grant_viewer@example.com",
    });
    await seedVideoAccess(grantedPrivateUpload.id, viewer.id);

    const res = await agent.get("/api/v1/users/grant_owner/videos");
    expect(res.status).toBe(200);
    const titles = res.body.items.map((item) => item.title).sort();
    expect(titles).toEqual(["Granted private video", "Public video"]);
  });

  test("an admin sees every visibility on another user's channel", async () => {
    const { queryRows } = await import("../helpers/db.js");
    const owner = await seedUser({ username: "admin_view_owner", email: "admin_view_owner@example.com" });
    const hiddenUpload = await seedUpload({ userId: owner.id });
    await seedMetadata(hiddenUpload.id, { title: "Hidden video", visibility: "hidden" });
    const privateUpload = await seedUpload({ userId: owner.id });
    await seedMetadata(privateUpload.id, { title: "Private video", visibility: "private" });

    const agent = createTestAgent();
    const { user: admin } = await registerSession(agent, {
      username: "admin_viewer",
      email: "admin_viewer@example.com",
    });
    const [adminRole] = await queryRows("SELECT id FROM ROLES WHERE name = :name", { name: "admin" });
    await queryRows("UPDATE USERS SET role_id = :roleId WHERE id = :id", {
      roleId: adminRole.id,
      id: admin.id,
    });

    const res = await agent.get("/api/v1/users/admin_view_owner/videos");
    expect(res.status).toBe(200);
    const titles = res.body.items.map((item) => item.title).sort();
    expect(titles).toEqual(["Hidden video", "Private video"]);
  });

  test("sort=oldest and sort=views reorder the video list", async () => {
    const owner = await seedUser({ username: "sort_owner", email: "sort_owner@example.com" });

    const older = await seedUpload({ userId: owner.id });
    await seedMetadata(older.id, {
      title: "Older, fewer views",
      visibility: "public",
      viewCount: 1,
      createdAt: new Date(Date.now() - 60_000),
    });
    const newer = await seedUpload({ userId: owner.id });
    await seedMetadata(newer.id, { title: "Newer, more views", visibility: "public", viewCount: 100 });

    const client = createTestClient();

    const oldestRes = await client.get("/api/v1/users/sort_owner/videos?sort=oldest");
    expect(oldestRes.status).toBe(200);
    expect(oldestRes.body.items.map((item) => item.title)).toEqual([
      "Older, fewer views",
      "Newer, more views",
    ]);

    const viewsRes = await client.get("/api/v1/users/sort_owner/videos?sort=views");
    expect(viewsRes.status).toBe(200);
    expect(viewsRes.body.items.map((item) => item.title)).toEqual([
      "Newer, more views",
      "Older, fewer views",
    ]);
  });

  test("rejects an invalid sort with 400 invalid_query", async () => {
    await seedUser({ username: "sort_bad_query", email: "sort_bad_query@example.com" });
    const client = createTestClient();
    const res = await client.get("/api/v1/users/sort_bad_query/videos?sort=bogus");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });
});

describe("subscribe / unsubscribe / subscription state", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("unauthenticated POST /users/:id/subscribe returns 401", async () => {
    const target = await seedUser({ username: "sub_target1", email: "sub_target1@example.com" });
    const client = createTestClient();
    // Bearer header (even invalid) bypasses the CSRF check so requireAuth's
    // 401 is what's actually under test, matching admin-users.test.js's convention.
    const res = await client
      .post(`/api/v1/users/${target.id}/subscribe`)
      .set("Authorization", "Bearer jt_not_a_real_key");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("subscribing creates a row and is idempotent", async () => {
    const target = await seedUser({ username: "sub_target2", email: "sub_target2@example.com" });
    const agent = createTestAgent();
    const { csrfToken } = await registerSession(agent, {
      username: "sub_subscriber",
      email: "sub_subscriber@example.com",
    });

    const first = await agent
      .post(`/api/v1/users/${target.id}/subscribe`)
      .set("X-CSRF-Token", csrfToken)
      .send();
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ subscribed: true });

    const second = await agent
      .post(`/api/v1/users/${target.id}/subscribe`)
      .set("X-CSRF-Token", csrfToken)
      .send();
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ subscribed: true });

    const state = await agent.get(`/api/v1/users/${target.id}/subscription`);
    expect(state.body).toEqual({ subscribed: true });
  });

  test("rejects self-subscribe with 400 invalid_body", async () => {
    const agent = createTestAgent();
    const { csrfToken, user } = await registerSession(agent, {
      username: "sub_self",
      email: "sub_self@example.com",
    });

    const res = await agent
      .post(`/api/v1/users/${user.id}/subscribe`)
      .set("X-CSRF-Token", csrfToken)
      .send();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("returns 404 subscribing to an unknown user id", async () => {
    const agent = createTestAgent();
    const { csrfToken } = await registerSession(agent, {
      username: "sub_unknown_target",
      email: "sub_unknown_target@example.com",
    });

    const res = await agent
      .post("/api/v1/users/999999/subscribe")
      .set("X-CSRF-Token", csrfToken)
      .send();
    expect(res.status).toBe(404);
  });

  test("unsubscribing removes the row and is idempotent", async () => {
    const target = await seedUser({ username: "sub_target3", email: "sub_target3@example.com" });
    const agent = createTestAgent();
    const { csrfToken, user } = await registerSession(agent, {
      username: "sub_unsubscriber",
      email: "sub_unsubscriber@example.com",
    });
    await seedSubscription(user.id, target.id);

    const first = await agent
      .delete(`/api/v1/users/${target.id}/subscribe`)
      .set("X-CSRF-Token", csrfToken)
      .send();
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ subscribed: false });

    const second = await agent
      .delete(`/api/v1/users/${target.id}/subscribe`)
      .set("X-CSRF-Token", csrfToken)
      .send();
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ subscribed: false });
  });

  test("getSubscriptionState returns false when not subscribed", async () => {
    const target = await seedUser({ username: "sub_target4", email: "sub_target4@example.com" });
    const agent = createTestAgent();
    await registerSession(agent, {
      username: "sub_checker",
      email: "sub_checker@example.com",
    });

    const res = await agent.get(`/api/v1/users/${target.id}/subscription`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ subscribed: false });
  });

  test("unauthenticated GET /users/:id/subscription returns 401", async () => {
    const target = await seedUser({ username: "sub_target5", email: "sub_target5@example.com" });
    const client = createTestClient();
    const res = await client.get(`/api/v1/users/${target.id}/subscription`);
    expect(res.status).toBe(401);
  });
});

describe("ban / unban", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  /**
   * Registers an admin session by creating a user then promoting their role
   * directly in the DB (there is no public "become admin" endpoint).
   *
   * @returns {Promise<{agent: import('supertest').SuperAgentTest, csrfToken: string, user: object}>}
   *   Authenticated admin session.
   */
  async function registerAdminSession() {
    const { queryRows } = await import("../helpers/db.js");
    const agent = createTestAgent();
    const { csrfToken, user } = await registerSession(agent, {
      username: "ban_admin",
      email: "ban_admin@example.com",
    });
    const [adminRole] = await queryRows("SELECT id FROM ROLES WHERE name = :name", {
      name: "admin",
    });
    await queryRows("UPDATE USERS SET role_id = :roleId WHERE id = :id", {
      roleId: adminRole.id,
      id: user.id,
    });
    return { agent, csrfToken, user };
  }

  test("unauthenticated POST /users/:id/ban returns 401", async () => {
    const target = await seedUser({ username: "ban_target1", email: "ban_target1@example.com" });
    const client = createTestClient();
    const res = await client
      .post(`/api/v1/users/${target.id}/ban`)
      .set("Authorization", "Bearer jt_not_a_real_key");
    expect(res.status).toBe(401);
  });

  test("non-admin POST /users/:id/ban returns 403", async () => {
    const target = await seedUser({ username: "ban_target2", email: "ban_target2@example.com" });
    const agent = createTestAgent();
    const { csrfToken } = await registerSession(agent, {
      username: "ban_non_admin",
      email: "ban_non_admin@example.com",
    });

    const res = await agent
      .post(`/api/v1/users/${target.id}/ban`)
      .set("X-CSRF-Token", csrfToken)
      .send();
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("admin can ban a user, setting their role to locked", async () => {
    const target = await seedUser({ username: "ban_target3", email: "ban_target3@example.com" });
    const { agent, csrfToken } = await registerAdminSession();

    const res = await agent
      .post(`/api/v1/users/${target.id}/ban`)
      .set("X-CSRF-Token", csrfToken)
      .send();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: target.id, username: "ban_target3", role: "locked" });
  });

  test("admin cannot ban themselves", async () => {
    const { agent, csrfToken, user } = await registerAdminSession();

    const res = await agent
      .post(`/api/v1/users/${user.id}/ban`)
      .set("X-CSRF-Token", csrfToken)
      .send();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("admin can unban a user, setting their role to viewer", async () => {
    const target = await seedUser({ username: "ban_target4", email: "ban_target4@example.com" });
    const { agent, csrfToken } = await registerAdminSession();

    await agent.post(`/api/v1/users/${target.id}/ban`).set("X-CSRF-Token", csrfToken).send();

    const res = await agent
      .delete(`/api/v1/users/${target.id}/ban`)
      .set("X-CSRF-Token", csrfToken)
      .send();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: target.id, username: "ban_target4", role: "viewer" });
  });

  test("returns 404 banning an unknown user id", async () => {
    const { agent, csrfToken } = await registerAdminSession();
    const res = await agent
      .post("/api/v1/users/999999/ban")
      .set("X-CSRF-Token", csrfToken)
      .send();
    expect(res.status).toBe(404);
  });
});

describe("GET /users/:username/banner", () => {
  beforeAll(async () => {
    await setupSchema();
    await mkdir(bannersDir, { recursive: true });
  });

  afterEach(async () => {
    await resetTables();
  });

  test("returns 404 for an unknown username", async () => {
    const client = createTestClient();
    const res = await client.get("/api/v1/users/no_such_user/banner");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("returns 404 for a known user with no banner set", async () => {
    await seedUser({ username: "bannerless", email: "bannerless@example.com" });

    const client = createTestClient();
    const res = await client.get("/api/v1/users/bannerless/banner");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("serves the banner image with the correct content type, no auth required", async () => {
    const filename = "test-banner.jpg";
    await writeFile(join(bannersDir, filename), Buffer.from("fake-jpeg-bytes"));
    await seedUser({
      username: "banner_owner",
      email: "banner_owner@example.com",
      bannerFilename: filename,
    });

    const client = createTestClient();
    const res = await client.get("/api/v1/users/banner_owner/banner");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.body).toEqual(Buffer.from("fake-jpeg-bytes"));
  });
});

describe("POST/DELETE /users/:id/banner", () => {
  beforeAll(async () => {
    await setupSchema();
    await mkdir(bannersDir, { recursive: true });
  });

  afterEach(async () => {
    await resetTables();
  });

  /**
   * Registers a moderator session by creating a user then promoting their
   * role directly in the DB, mirroring `registerAdminSession` above.
   *
   * @returns {Promise<{agent: import('supertest').SuperAgentTest, csrfToken: string, user: object}>}
   *   Authenticated moderator session.
   */
  async function registerModeratorSession() {
    const { queryRows } = await import("../helpers/db.js");
    const agent = createTestAgent();
    const { csrfToken, user } = await registerSession(agent, {
      username: "banner_moderator",
      email: "banner_moderator@example.com",
    });
    const [moderatorRole] = await queryRows("SELECT id FROM ROLES WHERE name = :name", {
      name: "moderator",
    });
    await queryRows("UPDATE USERS SET role_id = :roleId WHERE id = :id", {
      roleId: moderatorRole.id,
      id: user.id,
    });
    return { agent, csrfToken, user };
  }

  test("unauthenticated POST returns 401", async () => {
    const target = await seedUser({ username: "banner_target1", email: "banner_target1@example.com" });
    const client = createTestClient();
    const res = await client
      .post(`/api/v1/users/${target.id}/banner`)
      .set("Authorization", "Bearer jt_not_a_real_key")
      .attach("file", Buffer.from("fake-jpeg-bytes"), "banner.jpg");
    expect(res.status).toBe(401);
  });

  test("the owner can upload and then delete their own banner", async () => {
    const agent = createTestAgent();
    const { csrfToken, user } = await registerSession(agent, {
      username: "banner_self_owner",
      email: "banner_self_owner@example.com",
    });

    const uploadRes = await agent
      .post(`/api/v1/users/${user.id}/banner`)
      .set("X-CSRF-Token", csrfToken)
      .attach("file", Buffer.from("fake-jpeg-bytes"), "banner.jpg");
    expect(uploadRes.status).toBe(200);
    expect(typeof uploadRes.body.bannerFilename).toBe("string");
    const savedContents = await readFile(join(bannersDir, uploadRes.body.bannerFilename));
    expect(savedContents).toEqual(Buffer.from("fake-jpeg-bytes"));

    const deleteRes = await agent
      .delete(`/api/v1/users/${user.id}/banner`)
      .set("X-CSRF-Token", csrfToken)
      .send();
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body).toEqual({ success: true });

    const afterDelete = await createTestClient().get(`/api/v1/users/banner_self_owner/banner`);
    expect(afterDelete.status).toBe(404);
  });

  test("a moderator can upload and delete another user's banner", async () => {
    const target = await seedUser({ username: "banner_target2", email: "banner_target2@example.com" });
    const { agent, csrfToken } = await registerModeratorSession();

    const uploadRes = await agent
      .post(`/api/v1/users/${target.id}/banner`)
      .set("X-CSRF-Token", csrfToken)
      .attach("file", Buffer.from("fake-jpeg-bytes"), "banner.jpg");
    expect(uploadRes.status).toBe(200);

    const deleteRes = await agent
      .delete(`/api/v1/users/${target.id}/banner`)
      .set("X-CSRF-Token", csrfToken)
      .send();
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body).toEqual({ success: true });
  });

  test("a plain viewer gets 403 trying to change someone else's banner", async () => {
    const target = await seedUser({ username: "banner_target3", email: "banner_target3@example.com" });
    const agent = createTestAgent();
    const { csrfToken } = await registerSession(agent, {
      username: "banner_plain_viewer",
      email: "banner_plain_viewer@example.com",
    });

    const uploadRes = await agent
      .post(`/api/v1/users/${target.id}/banner`)
      .set("X-CSRF-Token", csrfToken)
      .attach("file", Buffer.from("fake-jpeg-bytes"), "banner.jpg");
    expect(uploadRes.status).toBe(403);
    expect(uploadRes.body.error).toBe("forbidden");

    const deleteRes = await agent
      .delete(`/api/v1/users/${target.id}/banner`)
      .set("X-CSRF-Token", csrfToken)
      .send();
    expect(deleteRes.status).toBe(403);
    expect(deleteRes.body.error).toBe("forbidden");
  });

  test("returns 404 uploading a banner for an unknown user id", async () => {
    const { agent, csrfToken } = await registerModeratorSession();
    const res = await agent
      .post("/api/v1/users/999999/banner")
      .set("X-CSRF-Token", csrfToken)
      .attach("file", Buffer.from("fake-jpeg-bytes"), "banner.jpg");
    expect(res.status).toBe(404);
  });
});

describe("POST/DELETE /users/:id/avatar", () => {
  beforeAll(async () => {
    await setupSchema();
    await mkdir(avatarsDir, { recursive: true });
  });

  afterEach(async () => {
    await resetTables();
  });

  /**
   * Seeds a moderator account with an API key, avoiding the shared
   * credential-endpoint rate limiter that a full HTTP registration would
   * count against (this file already registers many sessions elsewhere).
   *
   * @returns {Promise<{rawKey: string, user: object}>} Seeded moderator and its raw API key.
   */
  async function seedModerator() {
    const { queryRows } = await import("../helpers/db.js");
    const [moderatorRole] = await queryRows("SELECT id FROM ROLES WHERE name = :name", {
      name: "moderator",
    });
    const user = await seedUser({
      username: "avatar_moderator",
      email: "avatar_moderator@example.com",
      roleId: moderatorRole.id,
    });
    const { rawKey } = await seedUserApiKey(user.id, "jt_test_avatar_moderator_key");
    return { rawKey, user };
  }

  test("unauthenticated POST returns 401", async () => {
    const target = await seedUser({ username: "avatar_id_target1", email: "avatar_id_target1@example.com" });
    const client = createTestClient();
    const res = await client
      .post(`/api/v1/users/${target.id}/avatar`)
      .set("Authorization", "Bearer jt_not_a_real_key")
      .attach("file", Buffer.from("fake-jpeg-bytes"), "avatar.jpg");
    expect(res.status).toBe(401);
  });

  test("the owner can upload and then delete their own avatar", async () => {
    const user = await seedUser({ username: "avatar_self_owner", email: "avatar_self_owner@example.com" });
    const { rawKey } = await seedUserApiKey(user.id, "jt_test_avatar_self_owner_key");
    const client = createTestClient();

    const uploadRes = await client
      .post(`/api/v1/users/${user.id}/avatar`)
      .set("Authorization", `Bearer ${rawKey}`)
      .attach("file", Buffer.from("fake-jpeg-bytes"), "avatar.jpg");
    expect(uploadRes.status).toBe(200);
    expect(typeof uploadRes.body.avatarFilename).toBe("string");
    const savedContents = await readFile(join(avatarsDir, uploadRes.body.avatarFilename));
    expect(savedContents).toEqual(Buffer.from("fake-jpeg-bytes"));

    const deleteRes = await client
      .delete(`/api/v1/users/${user.id}/avatar`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send();
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body).toEqual({ success: true });

    const afterDelete = await createTestClient().get(`/api/v1/users/avatar_self_owner/avatar`);
    expect(afterDelete.status).toBe(404);
  });

  test("a moderator can upload and delete another user's avatar", async () => {
    const target = await seedUser({ username: "avatar_id_target2", email: "avatar_id_target2@example.com" });
    const { rawKey } = await seedModerator();
    const client = createTestClient();

    const uploadRes = await client
      .post(`/api/v1/users/${target.id}/avatar`)
      .set("Authorization", `Bearer ${rawKey}`)
      .attach("file", Buffer.from("fake-jpeg-bytes"), "avatar.jpg");
    expect(uploadRes.status).toBe(200);

    const deleteRes = await client
      .delete(`/api/v1/users/${target.id}/avatar`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send();
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body).toEqual({ success: true });
  });

  test("a plain viewer gets 403 trying to change someone else's avatar", async () => {
    const target = await seedUser({ username: "avatar_id_target3", email: "avatar_id_target3@example.com" });
    const viewer = await seedUser({ username: "avatar_plain_viewer", email: "avatar_plain_viewer@example.com" });
    const { rawKey } = await seedUserApiKey(viewer.id, "jt_test_avatar_plain_viewer_key");
    const client = createTestClient();

    const uploadRes = await client
      .post(`/api/v1/users/${target.id}/avatar`)
      .set("Authorization", `Bearer ${rawKey}`)
      .attach("file", Buffer.from("fake-jpeg-bytes"), "avatar.jpg");
    expect(uploadRes.status).toBe(403);
    expect(uploadRes.body.error).toBe("forbidden");

    const deleteRes = await client
      .delete(`/api/v1/users/${target.id}/avatar`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send();
    expect(deleteRes.status).toBe(403);
    expect(deleteRes.body.error).toBe("forbidden");
  });

  test("returns 404 uploading an avatar for an unknown user id", async () => {
    const { rawKey } = await seedModerator();
    const res = await createTestClient()
      .post("/api/v1/users/999999/avatar")
      .set("Authorization", `Bearer ${rawKey}`)
      .attach("file", Buffer.from("fake-jpeg-bytes"), "avatar.jpg");
    expect(res.status).toBe(404);
  });
});

describe("PATCH /users/:id/profile", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  /**
   * Seeds a moderator account with an API key, avoiding the shared
   * credential-endpoint rate limiter that a full HTTP registration would
   * count against (this file already registers many sessions elsewhere).
   *
   * @returns {Promise<{rawKey: string, user: object}>} Seeded moderator and its raw API key.
   */
  async function seedModerator() {
    const { queryRows } = await import("../helpers/db.js");
    const [moderatorRole] = await queryRows("SELECT id FROM ROLES WHERE name = :name", {
      name: "moderator",
    });
    const user = await seedUser({
      username: "profile_moderator",
      email: "profile_moderator@example.com",
      roleId: moderatorRole.id,
    });
    const { rawKey } = await seedUserApiKey(user.id, "jt_test_profile_moderator_key");
    return { rawKey, user };
  }

  test("unauthenticated PATCH returns 401", async () => {
    const target = await seedUser({ username: "profile_id_target1", email: "profile_id_target1@example.com" });
    const client = createTestClient();
    const res = await client
      .patch(`/api/v1/users/${target.id}/profile`)
      .set("Authorization", "Bearer jt_not_a_real_key")
      .send({ displayName: "New Name" });
    expect(res.status).toBe(401);
  });

  test("the owner can update their own displayName and bio", async () => {
    const user = await seedUser({ username: "profile_self_owner", email: "profile_self_owner@example.com" });
    const { rawKey } = await seedUserApiKey(user.id, "jt_test_profile_self_owner_key");

    const res = await createTestClient()
      .patch(`/api/v1/users/${user.id}/profile`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ displayName: "Self Updated", bio: "My new bio" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ displayName: "Self Updated", bio: "My new bio" });
  });

  test("a moderator can update another user's displayName and bio", async () => {
    const target = await seedUser({ username: "profile_id_target2", email: "profile_id_target2@example.com" });
    const { rawKey } = await seedModerator();

    const res = await createTestClient()
      .patch(`/api/v1/users/${target.id}/profile`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ displayName: "Moderated Name" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ displayName: "Moderated Name" });
  });

  test("a plain viewer gets 403 trying to change someone else's profile", async () => {
    const target = await seedUser({ username: "profile_id_target3", email: "profile_id_target3@example.com" });
    const viewer = await seedUser({ username: "profile_plain_viewer", email: "profile_plain_viewer@example.com" });
    const { rawKey } = await seedUserApiKey(viewer.id, "jt_test_profile_plain_viewer_key");

    const res = await createTestClient()
      .patch(`/api/v1/users/${target.id}/profile`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ displayName: "Hijacked Name" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("rejects an empty body with 400 invalid_body", async () => {
    const user = await seedUser({ username: "profile_empty_body", email: "profile_empty_body@example.com" });
    const { rawKey } = await seedUserApiKey(user.id, "jt_test_profile_empty_body_key");

    const res = await createTestClient()
      .patch(`/api/v1/users/${user.id}/profile`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("returns 404 updating the profile of an unknown user id", async () => {
    const { rawKey } = await seedModerator();
    const res = await createTestClient()
      .patch("/api/v1/users/999999/profile")
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ displayName: "Ghost" });
    expect(res.status).toBe(404);
  });
});
