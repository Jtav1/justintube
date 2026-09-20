import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { Role } from "../../lib/models/index.js";
import { createTestClient } from "../helpers/app.js";
import {
  queryRows,
  resetTables,
  seedMetadata,
  seedPlaylist,
  seedPlaylistItem,
  seedUpload,
  seedUser,
  seedUserApiKey,
  setupSchema,
} from "../helpers/db.js";

/**
 * Seeds a user with the given role name and an API key for Bearer auth,
 * mirroring the identical helper in tests/http/playlists.test.js.
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
 * Seeds a viewable ORIGINAL_UPLOADS + VIDEO_METADATA pair.
 *
 * @param {object} [metadataOverrides] Overrides passed to seedMetadata.
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded upload.
 */
async function seedVideo(metadataOverrides = {}) {
  const upload = await seedUpload();
  await seedMetadata(upload.id, metadataOverrides);
  return upload;
}

/**
 * HTTP contract tests for the CAST shared watch-session REST surface
 * (routes/cast.js), backed by CAST_SESSIONS/CAST_QUEUE_ITEMS/CAST_SESSION_MEMBERS.
 * Realtime (Socket.IO) behavior is covered separately in cast-realtime.test.js;
 * this file only exercises the REST endpoints.
 */
describe("CAST endpoints (CAST_SESSIONS + CAST_QUEUE_ITEMS + CAST_SESSION_MEMBERS)", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  describe("POST /cast (createCastSpace)", () => {
    test("creates an owned session seeded from a playlist, without mutating the source playlist", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "create-key-1");
      const playlist = await seedPlaylist({ userId: owner.id, visibility: "private" });
      const videoA = await seedVideo();
      const videoB = await seedVideo();
      await seedPlaylistItem(playlist.id, videoA.id, { position: 0 });
      await seedPlaylistItem(playlist.id, videoB.id, { position: 1 });

      const res = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer create-key-1")
        .send({ sourceType: "playlist", playlistId: playlist.id });

      expect(res.status).toBe(201);
      expect(res.body.session.ownerUserId).toBe(owner.id);
      expect(res.body.session.sourcePlaylistId).toBe(playlist.id);
      expect(typeof res.body.session.code).toBe("string");
      expect(res.body.session.code.length).toBeGreaterThan(0);
      expect(res.body.nowPlaying.video.id).toBe(videoA.id);
      expect(res.body.queue.map((item) => item.video.id)).toEqual([videoB.id]);

      // Mutate the new CAST queue, then confirm the source playlist is untouched.
      await client
        .delete(`/api/v1/cast/${res.body.session.id}/queue/${res.body.queue[0].id}`)
        .set("Authorization", "Bearer create-key-1");
      const playlistRows = await queryRows(
        "SELECT * FROM PLAYLIST_ITEMS WHERE playlist_id = :playlistId ORDER BY position ASC",
        { playlistId: playlist.id },
      );
      expect(playlistRows).toHaveLength(2);
      expect(Number(playlistRows[1].original_upload_id)).toBe(videoB.id);
    });

    test("excludes private playlist items the caller can't view", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "create-key-2");
      const videoOwner = await seedUserWithRoleAndKey("viewer", "create-key-2b");
      const playlist = await seedPlaylist({ userId: owner.id });
      const publicVideo = await seedVideo({ visibility: "public" });
      const privateVideo = await seedUpload({ userId: videoOwner.id });
      await seedMetadata(privateVideo.id, { visibility: "private" });
      await seedPlaylistItem(playlist.id, publicVideo.id, { position: 0 });
      await seedPlaylistItem(playlist.id, privateVideo.id, { position: 1 });

      const res = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer create-key-2")
        .send({ sourceType: "playlist", playlistId: playlist.id });

      expect(res.status).toBe(201);
      expect(res.body.nowPlaying.video.id).toBe(publicVideo.id);
      expect(res.body.queue).toHaveLength(0);
    });

    test("creates a session seeded from a single video", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "create-key-3");
      const video = await seedVideo();

      const res = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer create-key-3")
        .send({ sourceType: "video", videoId: String(video.id) });

      expect(res.status).toBe(201);
      expect(res.body.nowPlaying.video.id).toBe(video.id);
      expect(res.body.queue).toHaveLength(0);
    });

    test("creates an empty session", async () => {
      await seedUserWithRoleAndKey("viewer", "create-key-4");

      const res = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer create-key-4")
        .send({ sourceType: "empty" });

      expect(res.status).toBe(201);
      expect(res.body.nowPlaying).toBeNull();
      expect(res.body.queue).toHaveLength(0);
    });

    test("rejects an invalid sourceType with 400", async () => {
      await seedUserWithRoleAndKey("viewer", "create-key-5");

      const res = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer create-key-5")
        .send({ sourceType: "bogus" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_body");
    });

    test("404s for a playlist that doesn't exist", async () => {
      await seedUserWithRoleAndKey("viewer", "create-key-6");

      const res = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer create-key-6")
        .send({ sourceType: "playlist", playlistId: 999999 });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });

    test("rejects an anonymous request with 403 csrf_invalid", async () => {
      const res = await client.post("/api/v1/cast").send({ sourceType: "empty" });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("csrf_invalid");
    });
  });

  describe("POST /cast/join (joinCastSpace)", () => {
    async function createSession(rawKey) {
      const res = await client
        .post("/api/v1/cast")
        .set("Authorization", `Bearer ${rawKey}`)
        .send({ sourceType: "empty" });
      return res.body;
    }

    test("joins an active session by code", async () => {
      await seedUserWithRoleAndKey("viewer", "join-owner-1");
      const session = await createSession("join-owner-1");
      const joiner = await seedUserWithRoleAndKey("viewer", "join-key-1");

      const res = await client
        .post("/api/v1/cast/join")
        .set("Authorization", "Bearer join-key-1")
        .send({ code: session.session.code });

      expect(res.status).toBe(200);
      expect(res.body.session.id).toBe(session.session.id);
      const memberIds = res.body.members.map((member) => member.userId);
      expect(memberIds).toContain(joiner.id);
    });

    test("404s for an unknown code", async () => {
      await seedUserWithRoleAndKey("viewer", "join-key-2");

      const res = await client
        .post("/api/v1/cast/join")
        .set("Authorization", "Bearer join-key-2")
        .send({ code: "NOPE99" });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });

    test("404s for an ended session's code", async () => {
      await seedUserWithRoleAndKey("viewer", "join-owner-3");
      const session = await createSession("join-owner-3");
      await client
        .post(`/api/v1/cast/${session.session.id}/end`)
        .set("Authorization", "Bearer join-owner-3");
      await seedUserWithRoleAndKey("viewer", "join-key-3");

      const res = await client
        .post("/api/v1/cast/join")
        .set("Authorization", "Bearer join-key-3")
        .send({ code: session.session.code });

      expect(res.status).toBe(404);
    });

    test("rejects a previously-kicked member with 403 kicked_from_session", async () => {
      await seedUserWithRoleAndKey("viewer", "join-owner-4");
      const session = await createSession("join-owner-4");
      const kicked = await seedUserWithRoleAndKey("viewer", "join-key-4");
      await client
        .post("/api/v1/cast/join")
        .set("Authorization", "Bearer join-key-4")
        .send({ code: session.session.code });
      await client
        .delete(`/api/v1/cast/${session.session.id}/members/${kicked.id}`)
        .set("Authorization", "Bearer join-owner-4");

      const res = await client
        .post("/api/v1/cast/join")
        .set("Authorization", "Bearer join-key-4")
        .send({ code: session.session.code });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("kicked_from_session");
    });
  });

  describe("GET /cast/:id (getCastSpace)", () => {
    test("returns the snapshot for a member", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "get-key-1");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer get-key-1")
        .send({ sourceType: "empty" });

      const res = await client
        .get(`/api/v1/cast/${createRes.body.session.id}`)
        .set("Authorization", "Bearer get-key-1");

      expect(res.status).toBe(200);
      expect(res.body.session.ownerUserId).toBe(owner.id);
    });

    test("rejects a non-member with 403", async () => {
      await seedUserWithRoleAndKey("viewer", "get-key-2");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer get-key-2")
        .send({ sourceType: "empty" });
      await seedUserWithRoleAndKey("viewer", "get-key-2b");

      const res = await client
        .get(`/api/v1/cast/${createRes.body.session.id}`)
        .set("Authorization", "Bearer get-key-2b");

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    test("rejects an anonymous request with 401", async () => {
      await seedUserWithRoleAndKey("viewer", "get-key-3");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer get-key-3")
        .send({ sourceType: "empty" });

      const res = await client.get(`/api/v1/cast/${createRes.body.session.id}`);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("unauthorized");
    });

    test("404s for a session that doesn't exist", async () => {
      await seedUserWithRoleAndKey("viewer", "get-key-4");

      const res = await client
        .get("/api/v1/cast/999999")
        .set("Authorization", "Bearer get-key-4");

      expect(res.status).toBe(404);
    });
  });

  describe("queue mutation endpoints", () => {
    async function createSession(rawKey) {
      const res = await client
        .post("/api/v1/cast")
        .set("Authorization", `Bearer ${rawKey}`)
        .send({ sourceType: "empty" });
      return res.body;
    }

    test("a member can add a viewable video to the queue", async () => {
      await seedUserWithRoleAndKey("viewer", "queue-key-1");
      const session = await createSession("queue-key-1");
      const video = await seedVideo();

      const res = await client
        .post(`/api/v1/cast/${session.session.id}/queue`)
        .set("Authorization", "Bearer queue-key-1")
        .send({ videoId: String(video.id) });

      expect(res.status).toBe(201);
      expect(res.body.nowPlaying.video.id).toBe(video.id);
    });

    test("404s adding a private video the caller can't view", async () => {
      await seedUserWithRoleAndKey("viewer", "queue-key-2");
      const session = await createSession("queue-key-2");
      const videoOwner = await seedUserWithRoleAndKey("viewer", "queue-key-2b");
      const privateVideo = await seedUpload({ userId: videoOwner.id });
      await seedMetadata(privateVideo.id, { visibility: "private" });

      const res = await client
        .post(`/api/v1/cast/${session.session.id}/queue`)
        .set("Authorization", "Bearer queue-key-2")
        .send({ videoId: String(privateVideo.id) });

      expect(res.status).toBe(404);
    });

    test("rejects a non-member adding to the queue with 403", async () => {
      await seedUserWithRoleAndKey("viewer", "queue-key-3");
      const session = await createSession("queue-key-3");
      await seedUserWithRoleAndKey("viewer", "queue-key-3b");
      const video = await seedVideo();

      const res = await client
        .post(`/api/v1/cast/${session.session.id}/queue`)
        .set("Authorization", "Bearer queue-key-3b")
        .send({ videoId: String(video.id) });

      expect(res.status).toBe(403);
    });

    test("appends a whole playlist to the queue in playlist order", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "queue-pl-1");
      const session = await createSession("queue-pl-1");
      const existing = await seedVideo();
      await client
        .post(`/api/v1/cast/${session.session.id}/queue`)
        .set("Authorization", "Bearer queue-pl-1")
        .send({ videoId: String(existing.id) });

      const playlist = await seedPlaylist({ userId: owner.id, visibility: "private" });
      const videoA = await seedVideo();
      const videoB = await seedVideo();
      await seedPlaylistItem(playlist.id, videoA.id, { position: 0 });
      await seedPlaylistItem(playlist.id, videoB.id, { position: 1 });

      const res = await client
        .post(`/api/v1/cast/${session.session.id}/queue/playlist`)
        .set("Authorization", "Bearer queue-pl-1")
        .send({ playlistId: playlist.id });

      expect(res.status).toBe(201);
      expect(res.body.addedCount).toBe(2);
      // The already-playing item keeps playing; the playlist lands behind it.
      expect(res.body.nowPlaying.video.id).toBe(existing.id);
      expect(res.body.queue.map((item) => item.video.id)).toEqual([videoA.id, videoB.id]);
    });

    test("starts playing the playlist's first video when the queue was idle", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "queue-pl-2");
      const session = await createSession("queue-pl-2");
      const playlist = await seedPlaylist({ userId: owner.id });
      const videoA = await seedVideo();
      const videoB = await seedVideo();
      await seedPlaylistItem(playlist.id, videoA.id, { position: 0 });
      await seedPlaylistItem(playlist.id, videoB.id, { position: 1 });

      const res = await client
        .post(`/api/v1/cast/${session.session.id}/queue/playlist`)
        .set("Authorization", "Bearer queue-pl-2")
        .send({ playlistId: playlist.id });

      expect(res.status).toBe(201);
      expect(res.body.nowPlaying.video.id).toBe(videoA.id);
      expect(res.body.queue.map((item) => item.video.id)).toEqual([videoB.id]);
      expect(res.body.playback.status).toBe("playing");
    });

    test("skips playlist videos the caller can't view rather than failing", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "queue-pl-3");
      const session = await createSession("queue-pl-3");
      const videoOwner = await seedUserWithRoleAndKey("viewer", "queue-pl-3b");
      const playlist = await seedPlaylist({ userId: owner.id });
      const publicVideo = await seedVideo({ visibility: "public" });
      const privateVideo = await seedUpload({ userId: videoOwner.id });
      await seedMetadata(privateVideo.id, { visibility: "private" });
      await seedPlaylistItem(playlist.id, publicVideo.id, { position: 0 });
      await seedPlaylistItem(playlist.id, privateVideo.id, { position: 1 });

      const res = await client
        .post(`/api/v1/cast/${session.session.id}/queue/playlist`)
        .set("Authorization", "Bearer queue-pl-3")
        .send({ playlistId: playlist.id });

      expect(res.status).toBe(201);
      expect(res.body.addedCount).toBe(1);
      expect(res.body.nowPlaying.video.id).toBe(publicVideo.id);
      expect(res.body.queue).toHaveLength(0);
    });

    test("404s adding a private playlist the caller can't view", async () => {
      await seedUserWithRoleAndKey("viewer", "queue-pl-4");
      const session = await createSession("queue-pl-4");
      const playlistOwner = await seedUserWithRoleAndKey("viewer", "queue-pl-4b");
      const playlist = await seedPlaylist({
        userId: playlistOwner.id,
        visibility: "private",
      });
      const video = await seedVideo();
      await seedPlaylistItem(playlist.id, video.id, { position: 0 });

      const res = await client
        .post(`/api/v1/cast/${session.session.id}/queue/playlist`)
        .set("Authorization", "Bearer queue-pl-4")
        .send({ playlistId: playlist.id });

      expect(res.status).toBe(404);
    });

    test("rejects a non-member adding a playlist with 403", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "queue-pl-5");
      const session = await createSession("queue-pl-5");
      await seedUserWithRoleAndKey("viewer", "queue-pl-5b");
      const playlist = await seedPlaylist({ userId: owner.id, visibility: "public" });

      const res = await client
        .post(`/api/v1/cast/${session.session.id}/queue/playlist`)
        .set("Authorization", "Bearer queue-pl-5b")
        .send({ playlistId: playlist.id });

      expect(res.status).toBe(403);
    });

    test("400s on a missing or non-numeric playlistId", async () => {
      await seedUserWithRoleAndKey("viewer", "queue-pl-6");
      const session = await createSession("queue-pl-6");

      const res = await client
        .post(`/api/v1/cast/${session.session.id}/queue/playlist`)
        .set("Authorization", "Bearer queue-pl-6")
        .send({ playlistId: "not-a-number" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_body");
    });

    test("removes a queue item", async () => {
      await seedUserWithRoleAndKey("viewer", "queue-key-4");
      const session = await createSession("queue-key-4");
      const videoA = await seedVideo();
      const videoB = await seedVideo();
      await client
        .post(`/api/v1/cast/${session.session.id}/queue`)
        .set("Authorization", "Bearer queue-key-4")
        .send({ videoId: String(videoA.id) });
      const addRes = await client
        .post(`/api/v1/cast/${session.session.id}/queue`)
        .set("Authorization", "Bearer queue-key-4")
        .send({ videoId: String(videoB.id) });
      const queuedItem = addRes.body.queue[0];

      const res = await client
        .delete(`/api/v1/cast/${session.session.id}/queue/${queuedItem.id}`)
        .set("Authorization", "Bearer queue-key-4");

      expect(res.status).toBe(204);
    });

    test("reorders queued items", async () => {
      await seedUserWithRoleAndKey("viewer", "queue-key-5");
      const session = await createSession("queue-key-5");
      const videoA = await seedVideo();
      const videoB = await seedVideo();
      const videoC = await seedVideo();
      await client
        .post(`/api/v1/cast/${session.session.id}/queue`)
        .set("Authorization", "Bearer queue-key-5")
        .send({ videoId: String(videoA.id) });
      await client
        .post(`/api/v1/cast/${session.session.id}/queue`)
        .set("Authorization", "Bearer queue-key-5")
        .send({ videoId: String(videoB.id) });
      const thirdRes = await client
        .post(`/api/v1/cast/${session.session.id}/queue`)
        .set("Authorization", "Bearer queue-key-5")
        .send({ videoId: String(videoC.id) });
      const lastQueuedItem = thirdRes.body.queue[thirdRes.body.queue.length - 1];

      const res = await client
        .patch(`/api/v1/cast/${session.session.id}/queue/${lastQueuedItem.id}/move`)
        .set("Authorization", "Bearer queue-key-5")
        .send({ toIndex: 0 });

      expect(res.status).toBe(200);
      expect(res.body.queue[0].id).toBe(lastQueuedItem.id);
    });
  });

  describe("GET /cast/:id/members (listCastMembers)", () => {
    test("lists active members", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "members-key-1");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer members-key-1")
        .send({ sourceType: "empty" });
      const joiner = await seedUserWithRoleAndKey("viewer", "members-key-1b");
      await client
        .post("/api/v1/cast/join")
        .set("Authorization", "Bearer members-key-1b")
        .send({ code: createRes.body.session.code });

      const res = await client
        .get(`/api/v1/cast/${createRes.body.session.id}/members`)
        .set("Authorization", "Bearer members-key-1");

      expect(res.status).toBe(200);
      const userIds = res.body.items.map((item) => item.userId).sort((a, b) => a - b);
      expect(userIds).toEqual([owner.id, joiner.id].sort((a, b) => a - b));
    });
  });

  describe("DELETE /cast/:id/members/:userId (kickCastMember)", () => {
    test("the owner can kick a member", async () => {
      await seedUserWithRoleAndKey("viewer", "kick-key-1");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer kick-key-1")
        .send({ sourceType: "empty" });
      const target = await seedUserWithRoleAndKey("viewer", "kick-key-1b");
      await client
        .post("/api/v1/cast/join")
        .set("Authorization", "Bearer kick-key-1b")
        .send({ code: createRes.body.session.code });

      const res = await client
        .delete(`/api/v1/cast/${createRes.body.session.id}/members/${target.id}`)
        .set("Authorization", "Bearer kick-key-1");

      expect(res.status).toBe(204);
    });

    test("rejects a non-owner attempting to kick with 403", async () => {
      await seedUserWithRoleAndKey("viewer", "kick-key-2");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer kick-key-2")
        .send({ sourceType: "empty" });
      const memberA = await seedUserWithRoleAndKey("viewer", "kick-key-2a");
      const memberB = await seedUserWithRoleAndKey("viewer", "kick-key-2b");
      await client
        .post("/api/v1/cast/join")
        .set("Authorization", "Bearer kick-key-2a")
        .send({ code: createRes.body.session.code });
      await client
        .post("/api/v1/cast/join")
        .set("Authorization", "Bearer kick-key-2b")
        .send({ code: createRes.body.session.code });

      const res = await client
        .delete(`/api/v1/cast/${createRes.body.session.id}/members/${memberB.id}`)
        .set("Authorization", "Bearer kick-key-2a");

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    test("rejects kicking the owner with 400", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "kick-key-3");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer kick-key-3")
        .send({ sourceType: "empty" });

      const res = await client
        .delete(`/api/v1/cast/${createRes.body.session.id}/members/${owner.id}`)
        .set("Authorization", "Bearer kick-key-3");

      expect(res.status).toBe(400);
    });
  });

  describe("POST /cast/:id/end (endCastSession)", () => {
    test("the owner can end the session, and GET afterward still returns 200 with status ended", async () => {
      await seedUserWithRoleAndKey("viewer", "end-key-1");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer end-key-1")
        .send({ sourceType: "empty" });

      const endRes = await client
        .post(`/api/v1/cast/${createRes.body.session.id}/end`)
        .set("Authorization", "Bearer end-key-1");
      expect(endRes.status).toBe(204);

      const getRes = await client
        .get(`/api/v1/cast/${createRes.body.session.id}`)
        .set("Authorization", "Bearer end-key-1");
      expect(getRes.status).toBe(200);
      expect(getRes.body.session.status).toBe("ended");
    });

    test("rejects a non-owner attempting to end with 403", async () => {
      await seedUserWithRoleAndKey("viewer", "end-key-2");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer end-key-2")
        .send({ sourceType: "empty" });
      await seedUserWithRoleAndKey("viewer", "end-key-2b");
      await client
        .post("/api/v1/cast/join")
        .set("Authorization", "Bearer end-key-2b")
        .send({ code: createRes.body.session.code });

      const res = await client
        .post(`/api/v1/cast/${createRes.body.session.id}/end`)
        .set("Authorization", "Bearer end-key-2b");

      expect(res.status).toBe(403);
    });

    test("an admin who is not the owner can end the session", async () => {
      await seedUserWithRoleAndKey("viewer", "end-key-4");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer end-key-4")
        .send({ sourceType: "empty" });
      await seedUserWithRoleAndKey("admin", "end-key-4-admin");

      const res = await client
        .post(`/api/v1/cast/${createRes.body.session.id}/end`)
        .set("Authorization", "Bearer end-key-4-admin");

      expect(res.status).toBe(204);
    });

    test("409s ending an already-ended session", async () => {
      await seedUserWithRoleAndKey("viewer", "end-key-3");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer end-key-3")
        .send({ sourceType: "empty" });
      await client
        .post(`/api/v1/cast/${createRes.body.session.id}/end`)
        .set("Authorization", "Bearer end-key-3");

      const res = await client
        .post(`/api/v1/cast/${createRes.body.session.id}/end`)
        .set("Authorization", "Bearer end-key-3");

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("session_ended");
    });
  });

  describe("PATCH /cast/:id (renameCastSession)", () => {
    test("the owner renames the session and the snapshot carries the new title", async () => {
      await seedUserWithRoleAndKey("viewer", "rename-key-1");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer rename-key-1")
        .send({ sourceType: "empty" });

      const res = await client
        .patch(`/api/v1/cast/${createRes.body.session.id}`)
        .set("Authorization", "Bearer rename-key-1")
        .send({ title: "Friday Movie Night" });

      expect(res.status).toBe(200);
      expect(res.body.session.title).toBe("Friday Movie Night");

      const getRes = await client
        .get(`/api/v1/cast/${createRes.body.session.id}`)
        .set("Authorization", "Bearer rename-key-1");
      expect(getRes.body.session.title).toBe("Friday Movie Night");
    });

    test("an admin who is not the owner can rename the session", async () => {
      await seedUserWithRoleAndKey("viewer", "rename-key-2");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer rename-key-2")
        .send({ sourceType: "empty" });
      await seedUserWithRoleAndKey("admin", "rename-key-2-admin");

      const res = await client
        .patch(`/api/v1/cast/${createRes.body.session.id}`)
        .set("Authorization", "Bearer rename-key-2-admin")
        .send({ title: "Renamed by an admin" });

      expect(res.status).toBe(200);
      expect(res.body.session.title).toBe("Renamed by an admin");
    });

    test("rejects a plain member attempting to rename with 403", async () => {
      await seedUserWithRoleAndKey("viewer", "rename-key-3");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer rename-key-3")
        .send({ sourceType: "empty" });
      await seedUserWithRoleAndKey("viewer", "rename-key-3b");
      await client
        .post("/api/v1/cast/join")
        .set("Authorization", "Bearer rename-key-3b")
        .send({ code: createRes.body.session.code });

      const res = await client
        .patch(`/api/v1/cast/${createRes.body.session.id}`)
        .set("Authorization", "Bearer rename-key-3b")
        .send({ title: "Not allowed" });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    test("400s on a blank title and on one longer than 255 characters", async () => {
      await seedUserWithRoleAndKey("viewer", "rename-key-4");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer rename-key-4")
        .send({ sourceType: "empty" });
      const id = createRes.body.session.id;

      const blank = await client
        .patch(`/api/v1/cast/${id}`)
        .set("Authorization", "Bearer rename-key-4")
        .send({ title: "   " });
      expect(blank.status).toBe(400);
      expect(blank.body.error).toBe("invalid_body");

      const tooLong = await client
        .patch(`/api/v1/cast/${id}`)
        .set("Authorization", "Bearer rename-key-4")
        .send({ title: "x".repeat(256) });
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.error).toBe("invalid_body");
    });

    test("409s renaming an ended session", async () => {
      await seedUserWithRoleAndKey("viewer", "rename-key-5");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer rename-key-5")
        .send({ sourceType: "empty" });
      await client
        .post(`/api/v1/cast/${createRes.body.session.id}/end`)
        .set("Authorization", "Bearer rename-key-5");

      const res = await client
        .patch(`/api/v1/cast/${createRes.body.session.id}`)
        .set("Authorization", "Bearer rename-key-5")
        .send({ title: "Too late" });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("session_ended");
    });
  });

  describe("POST /cast/:id/leave (leaveCastSession)", () => {
    test("a member leaves and drops off the member list, session stays active", async () => {
      await seedUserWithRoleAndKey("viewer", "leave-key-1");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer leave-key-1")
        .send({ sourceType: "empty" });
      const id = createRes.body.session.id;
      const joiner = await seedUserWithRoleAndKey("viewer", "leave-key-1b");
      await client
        .post("/api/v1/cast/join")
        .set("Authorization", "Bearer leave-key-1b")
        .send({ code: createRes.body.session.code });

      const res = await client
        .post(`/api/v1/cast/${id}/leave`)
        .set("Authorization", "Bearer leave-key-1b");
      expect(res.status).toBe(204);

      const membersRes = await client
        .get(`/api/v1/cast/${id}/members`)
        .set("Authorization", "Bearer leave-key-1");
      expect(membersRes.status).toBe(200);
      expect(membersRes.body.items.some((m) => m.userId === joiner.id)).toBe(false);

      const getRes = await client
        .get(`/api/v1/cast/${id}`)
        .set("Authorization", "Bearer leave-key-1");
      expect(getRes.body.session.status).toBe("active");
    });

    test("leaving twice still succeeds", async () => {
      await seedUserWithRoleAndKey("viewer", "leave-key-2");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer leave-key-2")
        .send({ sourceType: "empty" });
      await seedUserWithRoleAndKey("viewer", "leave-key-2b");
      await client
        .post("/api/v1/cast/join")
        .set("Authorization", "Bearer leave-key-2b")
        .send({ code: createRes.body.session.code });

      const first = await client
        .post(`/api/v1/cast/${createRes.body.session.id}/leave`)
        .set("Authorization", "Bearer leave-key-2b");
      const second = await client
        .post(`/api/v1/cast/${createRes.body.session.id}/leave`)
        .set("Authorization", "Bearer leave-key-2b");

      expect(first.status).toBe(204);
      expect(second.status).toBe(204);
    });

    test("the owner leaving does not end the session for everyone else", async () => {
      await seedUserWithRoleAndKey("viewer", "leave-key-3");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer leave-key-3")
        .send({ sourceType: "empty" });
      await seedUserWithRoleAndKey("viewer", "leave-key-3b");
      await client
        .post("/api/v1/cast/join")
        .set("Authorization", "Bearer leave-key-3b")
        .send({ code: createRes.body.session.code });

      const res = await client
        .post(`/api/v1/cast/${createRes.body.session.id}/leave`)
        .set("Authorization", "Bearer leave-key-3");
      expect(res.status).toBe(204);

      const getRes = await client
        .get(`/api/v1/cast/${createRes.body.session.id}`)
        .set("Authorization", "Bearer leave-key-3b");
      expect(getRes.status).toBe(200);
      expect(getRes.body.session.status).toBe("active");
    });

    test("404s leaving a session that doesn't exist", async () => {
      await seedUserWithRoleAndKey("viewer", "leave-key-4");

      const res = await client
        .post("/api/v1/cast/999999/leave")
        .set("Authorization", "Bearer leave-key-4");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });

    test("the session auto-ends once every member has left", async () => {
      await seedUserWithRoleAndKey("viewer", "leave-key-5");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer leave-key-5")
        .send({ sourceType: "empty" });
      const id = createRes.body.session.id;
      await seedUserWithRoleAndKey("viewer", "leave-key-5b");
      await client
        .post("/api/v1/cast/join")
        .set("Authorization", "Bearer leave-key-5b")
        .send({ code: createRes.body.session.code });

      const firstLeave = await client
        .post(`/api/v1/cast/${id}/leave`)
        .set("Authorization", "Bearer leave-key-5b");
      expect(firstLeave.status).toBe(204);

      const stillActive = await client
        .get(`/api/v1/cast/${id}`)
        .set("Authorization", "Bearer leave-key-5");
      expect(stillActive.body.session.status).toBe("active");

      const lastLeave = await client
        .post(`/api/v1/cast/${id}/leave`)
        .set("Authorization", "Bearer leave-key-5");
      expect(lastLeave.status).toBe(204);

      // No member (not even the former owner) can GET an ended session
      // anymore, so confirm via a mutation that only rejects ended sessions.
      const endRes = await client
        .post(`/api/v1/cast/${id}/end`)
        .set("Authorization", "Bearer leave-key-5");
      expect(endRes.status).toBe(409);
      expect(endRes.body.error).toBe("session_ended");
    });
  });
});
