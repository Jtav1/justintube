import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import {
  resetBasicIndexForTests,
  syncPlaylistIndex,
  syncUserIndex,
  syncVideoIndex,
} from "../../lib/search.js";
import { createTestAgent, createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedMetadata,
  seedPlaylist,
  seedPlaylistItem,
  seedUpload,
  seedUser,
  setupSchema,
} from "../helpers/db.js";
import { Role, User } from "../../lib/models/index.js";

/**
 * Registers a new viewer account then promotes it to admin directly in the
 * DB (there is no public "become admin" endpoint).
 *
 * @returns {Promise<{agent: import('supertest').SuperAgentTest}>}
 */
async function registerAdminSession() {
  const agent = createTestAgent();
  const csrfRes = await agent.get("/api/v1/auth/csrf");
  const registerRes = await agent
    .post("/api/v1/auth/register")
    .set("X-CSRF-Token", csrfRes.body.csrfToken)
    .send({
      username: "search_advanced_admin",
      email: "search_advanced_admin@example.com",
      password: "password123",
      displayName: "search_advanced_admin",
    });
  expect(registerRes.status).toBe(201);

  const adminRole = await Role.findOne({ where: { name: "admin" } });
  await User.update({ roleId: adminRole.id }, { where: { id: registerRes.body.user.id } });

  return { agent };
}

/**
 * HTTP contract tests for GET /search/advanced (the combined video/playlist/
 * user fuzzy search powering the search-results page) and the `limit` param
 * added to GET /search/suggest. Covers the default (in-process basic)
 * backend end-to-end over HTTP.
 */
describe("GET /search/advanced", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
    resetBasicIndexForTests();
  });

  test("finds a public video by title", async () => {
    const upload = await seedUpload({ status: "ready" });
    await seedMetadata(upload.id, { title: "Cats of the Internet", visibility: "public" });
    await syncVideoIndex(upload.id);

    const res = await client.get("/api/v1/search/advanced?q=cats");

    expect(res.status).toBe(200);
    expect(res.body.videos.map((v) => v.id)).toContain(upload.id);
    // videoId (the public id used by /video?v=... links, distinct from the
    // numeric id) must be present so the UI's VideoCard can link correctly.
    const hit = res.body.videos.find((v) => v.id === upload.id);
    expect(hit.videoId).toBe(upload.videoId);
  });

  test("finds a public playlist by title", async () => {
    const owner = await seedUser({ username: "playlist_owner" });
    const playlist = await seedPlaylist({
      userId: owner.id,
      title: "Great Road Trips",
      visibility: "public",
    });
    await syncPlaylistIndex(playlist.id);

    const res = await client.get("/api/v1/search/advanced?q=road+trips");

    expect(res.status).toBe(200);
    expect(res.body.playlists.map((p) => p.id)).toContain(playlist.id);
  });

  test("finds a public playlist by a contained public video's title (content search)", async () => {
    const owner = await seedUser({ username: "content_owner" });
    const playlist = await seedPlaylist({ userId: owner.id, visibility: "public" });
    const upload = await seedUpload({ status: "ready", userId: owner.id });
    await seedMetadata(upload.id, { title: "Skydiving Highlights", visibility: "public" });
    await seedPlaylistItem(playlist.id, upload.id);
    await syncPlaylistIndex(playlist.id);

    const res = await client.get("/api/v1/search/advanced?q=skydiving");

    expect(res.status).toBe(200);
    expect(res.body.playlists.map((p) => p.id)).toContain(playlist.id);
  });

  test("playlist results include real thumbnails/itemCount/owner, not placeholders", async () => {
    const owner = await seedUser({ username: "thumb_owner" });
    const playlist = await seedPlaylist({
      userId: owner.id,
      title: "Thumbnail Check",
      visibility: "public",
    });
    const upload = await seedUpload({ status: "ready", userId: owner.id });
    await seedMetadata(upload.id, { title: "Thumb Video", visibility: "public" });
    await seedPlaylistItem(playlist.id, upload.id);
    await syncPlaylistIndex(playlist.id);

    const res = await client.get("/api/v1/search/advanced?q=thumbnail");

    expect(res.status).toBe(200);
    const hit = res.body.playlists.find((p) => p.id === playlist.id);
    expect(hit).toBeDefined();
    expect(hit.itemCount).toBe(1);
    expect(hit.owner).toMatchObject({ id: owner.id, username: "thumb_owner" });
  });

  test("finds a user by display-name prefix, unauthenticated", async () => {
    const user = await seedUser({ username: "findme_user", displayName: "Findable Person" });
    await syncUserIndex(user.id);

    const res = await client.get("/api/v1/search/advanced?q=Findable");

    expect(res.status).toBe(200);
    const hit = res.body.users.find((u) => u.id === user.id);
    expect(hit).toBeDefined();
    expect(hit.username).toBe("findme_user");
  });

  test("close/fuzzy match: a slightly misspelled query still matches a video, playlist, and username", async () => {
    const owner = await seedUser({ username: "fuzzy_owner", displayName: "Fuzzy Wuzzy" });
    const upload = await seedUpload({ status: "ready", userId: owner.id });
    await seedMetadata(upload.id, { title: "Skateboarding Tricks", visibility: "public" });
    const playlist = await seedPlaylist({
      userId: owner.id,
      title: "Skateboarding Compilation",
      visibility: "public",
    });
    await syncVideoIndex(upload.id);
    await syncPlaylistIndex(playlist.id);
    await syncUserIndex(owner.id);

    const res = await client.get("/api/v1/search/advanced?q=Skatebording");

    expect(res.status).toBe(200);
    expect(res.body.videos.map((v) => v.id)).toContain(upload.id);
    expect(res.body.playlists.map((p) => p.id)).toContain(playlist.id);

    const res2 = await client.get("/api/v1/search/advanced?q=Fuzy+Wuzy");
    expect(res2.status).toBe(200);
    expect(res2.body.users.map((u) => u.id)).toContain(owner.id);
  });

  test("empty q returns all-empty arrays", async () => {
    const res = await client.get("/api/v1/search/advanced");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ videos: [], playlists: [], users: [] });
  });

  test("locked users don't appear in users[] for an anonymous caller", async () => {
    const lockedRole = await Role.findOne({ where: { name: "locked" } });
    const user = await seedUser({
      username: "locked_user",
      displayName: "Locked Person",
      roleId: lockedRole.id,
    });
    await syncUserIndex(user.id);

    const res = await client.get("/api/v1/search/advanced?q=Locked");

    expect(res.status).toBe(200);
    expect(res.body.users.map((u) => u.id)).not.toContain(user.id);
  });

  test("locked users don't appear in users[] for a non-admin authenticated caller", async () => {
    const lockedRole = await Role.findOne({ where: { name: "locked" } });
    const user = await seedUser({
      username: "locked_user_viewer",
      displayName: "Locked Person Viewer",
      roleId: lockedRole.id,
    });
    await syncUserIndex(user.id);

    const agent = createTestAgent();
    const csrfRes = await agent.get("/api/v1/auth/csrf");
    await agent
      .post("/api/v1/auth/register")
      .set("X-CSRF-Token", csrfRes.body.csrfToken)
      .send({
        username: "plain_search_viewer",
        email: "plain_search_viewer@example.com",
        password: "password123",
        displayName: "plain_search_viewer",
      });

    const res = await agent.get("/api/v1/search/advanced?q=Locked");

    expect(res.status).toBe(200);
    expect(res.body.users.map((u) => u.id)).not.toContain(user.id);
  });

  test("locked users appear in users[] for an admin caller, with their role included", async () => {
    const lockedRole = await Role.findOne({ where: { name: "locked" } });
    const user = await seedUser({
      username: "locked_user_admin_view",
      displayName: "Locked Person Admin View",
      roleId: lockedRole.id,
    });
    await syncUserIndex(user.id);

    const { agent } = await registerAdminSession();
    const res = await agent.get("/api/v1/search/advanced?q=Locked");

    expect(res.status).toBe(200);
    const hit = res.body.users.find((u) => u.id === user.id);
    expect(hit).toMatchObject({ role: "locked" });
  });
});

describe("GET /search/suggest?limit=", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
    resetBasicIndexForTests();
  });

  test("returns up to a custom limit (max 15)", async () => {
    for (let i = 0; i < 10; i += 1) {
      const upload = await seedUpload({ status: "ready" });
      await seedMetadata(upload.id, { title: `Suggest Video ${i}`, visibility: "public" });
      await syncVideoIndex(upload.id);
    }

    const res = await client.get("/api/v1/search/suggest?q=Suggest&limit=10");

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(10);
    // videoId must be present so a clicked suggestion can link to /video?v=...
    expect(res.body.items.every((item) => typeof item.videoId === "string")).toBe(true);
  });

  test("rejects a limit above 15", async () => {
    const res = await client.get("/api/v1/search/suggest?q=x&limit=16");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_query" });
  });
});
