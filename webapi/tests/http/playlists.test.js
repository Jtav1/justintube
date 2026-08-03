import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { Role } from "../../lib/models/index.js";
import { createTestClient } from "../helpers/app.js";
import {
  queryRows,
  resetTables,
  seedMetadata,
  seedPlaylist,
  seedPlaylistAccess,
  seedPlaylistItem,
  seedUpload,
  seedUser,
  seedUserApiKey,
  seedVideoAccess,
  setupSchema,
} from "../helpers/db.js";

/**
 * Seeds a user with the given role name and an API key for Bearer auth.
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
 * HTTP contract tests for playlist endpoints backed by USER_PLAYLISTS and
 * PLAYLIST_ITEMS, including ownership and visibility enforcement.
 */
describe("Playlist endpoints (USER_PLAYLISTS + PLAYLIST_ITEMS)", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  describe("POST /playlists (createPlaylist)", () => {
    test("creates a playlist owned by the caller and returns 201 with the Playlist", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "create-key-1");

      const res = await client
        .post("/api/v1/playlists")
        .set("Authorization", "Bearer create-key-1")
        .send({
          name: "Favourites",
          description: "Stuff I like",
          visibility: "private",
        });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: "Favourites",
        visibility: "private",
        itemCount: 0,
      });
      expect(res.body.id).toBeDefined();

      const rows = await queryRows("SELECT * FROM USER_PLAYLISTS");
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe("Favourites");
      expect(Number(rows[0].user_id)).toBe(owner.id);
    });

    test("rejects a request missing the required name with 400", async () => {
      await seedUserWithRoleAndKey("viewer", "create-key-2");

      const res = await client
        .post("/api/v1/playlists")
        .set("Authorization", "Bearer create-key-2")
        .send({ description: "no name" });

      expect(res.status).toBe(400);
    });

    test("rejects an anonymous request (no session, no API key) with 403 csrf_invalid", async () => {
      const res = await client
        .post("/api/v1/playlists")
        .send({ name: "Anon" });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("csrf_invalid");
    });
  });

  describe("GET /playlists (listPlaylists)", () => {
    test("anonymous callers see only public playlists", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "list-key-1");
      await seedPlaylist({ userId: owner.id, title: "Public one", visibility: "public" });
      await seedPlaylist({ userId: owner.id, title: "Private one", visibility: "private" });
      await seedPlaylist({ userId: owner.id, title: "Unlisted one", visibility: "unlisted" });

      const res = await client.get("/api/v1/playlists");

      expect(res.status).toBe(200);
      const names = res.body.items.map((item) => item.name);
      expect(names).toEqual(["Public one"]);
    });

    test("authenticated callers additionally see their own playlists of any visibility", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "list-key-2");
      await seedPlaylist({ userId: owner.id, title: "My private", visibility: "private" });
      await seedPlaylist({ userId: owner.id, title: "My unlisted", visibility: "unlisted" });
      await seedPlaylist({ userId: owner.id, title: "My hidden", visibility: "hidden" });

      const res = await client
        .get("/api/v1/playlists")
        .set("Authorization", "Bearer list-key-2");

      expect(res.status).toBe(200);
      const names = res.body.items.map((item) => item.name).sort();
      expect(names).toEqual(["My hidden", "My private", "My unlisted"].sort());
    });

    test("authenticated callers see another user's private playlist only with a PLAYLIST_ACCESS grant", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "list-key-3");
      const grantee = await seedUserWithRoleAndKey("viewer", "list-key-4");
      const granted = await seedPlaylist({ userId: owner.id, title: "Shared", visibility: "private" });
      await seedPlaylist({ userId: owner.id, title: "Not shared", visibility: "private" });
      await seedPlaylistAccess({ playlistId: granted.id, userId: grantee.id });

      const res = await client
        .get("/api/v1/playlists")
        .set("Authorization", "Bearer list-key-4");

      expect(res.status).toBe(200);
      const names = res.body.items.map((item) => item.name);
      expect(names).toEqual(["Shared"]);
    });

    test("excludes another user's unlisted/hidden playlists even though they're reachable by direct id", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "list-key-5");
      const viewer = await seedUserWithRoleAndKey("viewer", "list-key-6");
      const unlisted = await seedPlaylist({ userId: owner.id, title: "Unlisted", visibility: "unlisted" });
      await seedPlaylist({ userId: owner.id, title: "Hidden", visibility: "hidden" });

      const byId = await client
        .get(`/api/v1/playlists/${unlisted.id}`)
        .set("Authorization", "Bearer list-key-6");
      expect(byId.status).toBe(200);

      const listing = await client
        .get("/api/v1/playlists")
        .set("Authorization", "Bearer list-key-6");

      expect(listing.status).toBe(200);
      expect(listing.body.items).toEqual([]);
    });

    test("reports itemCount and up to 3 viewable thumbnails per playlist", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "list-key-7");
      const playlist = await seedPlaylist({ userId: owner.id, title: "Stack test", visibility: "public" });

      const uploadIds = [];
      for (let i = 0; i < 4; i += 1) {
        const upload = await seedUpload({ userId: owner.id });
        await seedMetadata(upload.id, { title: `Video ${i}`, visibility: "public" });
        uploadIds.push(upload.id);
      }

      for (const uploadId of uploadIds) {
        await client
          .post(`/api/v1/playlists/${playlist.id}/items`)
          .set("Authorization", "Bearer list-key-7")
          .send({ videoId: uploadId });
      }

      const res = await client.get("/api/v1/playlists");

      expect(res.status).toBe(200);
      const item = res.body.items.find((entry) => entry.id === playlist.id);
      expect(item.itemCount).toBe(4);
      expect(item.thumbnails).toEqual([]);
    });

    test("supports pagination via page/limit", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "list-key-8");
      for (let i = 0; i < 3; i += 1) {
        await seedPlaylist({ userId: owner.id, title: `Page playlist ${i}`, visibility: "public" });
      }

      const res = await client.get("/api/v1/playlists").query({ page: 1, limit: 2 });

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.page).toBe(1);
      expect(res.body.limit).toBe(2);
      expect(res.body.totalHits).toBe(3);
      expect(res.body.totalPages).toBe(2);
    });

    test("rejects an invalid page/limit with 400 invalid_query", async () => {
      const res = await client.get("/api/v1/playlists").query({ limit: 0 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_query");
    });
  });

  describe("GET /playlists/{id} (getPlaylist)", () => {
    test("returns 200 with the playlist, its items and itemCount", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "get-key-1");
      const playlist = await seedPlaylist({
        userId: owner.id,
        title: "Mix",
        visibility: "public",
      });

      const res = await client.get(`/api/v1/playlists/${playlist.id}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: "Mix" });
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.itemCount).toBe(0);
    });

    test("returns 404 for an unknown playlist id", async () => {
      const res = await client.get("/api/v1/playlists/999999");

      expect(res.status).toBe(404);
    });

    test("returns 404 for a private playlist without ownership or a grant", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "get-key-2");
      await seedUserWithRoleAndKey("viewer", "get-key-3");
      const playlist = await seedPlaylist({
        userId: owner.id,
        title: "Secret",
        visibility: "private",
      });

      const res = await client
        .get(`/api/v1/playlists/${playlist.id}`)
        .set("Authorization", "Bearer get-key-3");

      expect(res.status).toBe(404);
    });

    test("returns 200 for a private playlist when the caller has a PLAYLIST_ACCESS grant", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "get-key-4");
      const grantee = await seedUserWithRoleAndKey("viewer", "get-key-5");
      const playlist = await seedPlaylist({
        userId: owner.id,
        title: "Shared",
        visibility: "private",
      });
      await seedPlaylistAccess({ playlistId: playlist.id, userId: grantee.id });

      const res = await client
        .get(`/api/v1/playlists/${playlist.id}`)
        .set("Authorization", "Bearer get-key-5");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: "Shared" });
    });

    test("returns 200 for the owner of a private playlist", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "get-key-6");
      const playlist = await seedPlaylist({
        userId: owner.id,
        title: "Mine",
        visibility: "private",
      });

      const res = await client
        .get(`/api/v1/playlists/${playlist.id}`)
        .set("Authorization", "Bearer get-key-6");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: "Mine" });
    });

    test("filters out hidden and inaccessible private videos, even for the playlist owner", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "get-key-7");
      const videoOwner = await seedUserWithRoleAndKey("viewer", "get-key-7b");
      const playlist = await seedPlaylist({
        userId: owner.id,
        title: "Mixed visibility",
        visibility: "public",
      });

      const publicUpload = await seedUpload({ userId: videoOwner.id });
      await seedMetadata(publicUpload.id, { title: "Public video", visibility: "public" });

      const unlistedUpload = await seedUpload({ userId: videoOwner.id });
      await seedMetadata(unlistedUpload.id, { title: "Unlisted video", visibility: "unlisted" });

      const hiddenUpload = await seedUpload({ userId: owner.id });
      await seedMetadata(hiddenUpload.id, { title: "Hidden video", visibility: "hidden" });

      const privateNoGrantUpload = await seedUpload({ userId: videoOwner.id });
      await seedMetadata(privateNoGrantUpload.id, {
        title: "Private, no grant",
        visibility: "private",
      });

      const privateWithGrantUpload = await seedUpload({ userId: videoOwner.id });
      await seedMetadata(privateWithGrantUpload.id, {
        title: "Private, granted",
        visibility: "private",
      });
      await seedVideoAccess(privateWithGrantUpload.id, owner.id);

      for (const upload of [
        publicUpload,
        unlistedUpload,
        hiddenUpload,
        privateNoGrantUpload,
        privateWithGrantUpload,
      ]) {
        await client
          .post(`/api/v1/playlists/${playlist.id}/items`)
          .set("Authorization", "Bearer get-key-7")
          .send({ videoId: upload.id });
      }

      const res = await client
        .get(`/api/v1/playlists/${playlist.id}`)
        .set("Authorization", "Bearer get-key-7");

      expect(res.status).toBe(200);
      expect(res.body.itemCount).toBe(3);
      const titles = res.body.items.map((item) => item.title).sort();
      expect(titles).toEqual(
        ["Private, granted", "Public video", "Unlisted video"].sort(),
      );
    });
  });

  describe("PATCH /playlists/{id} (updatePlaylist)", () => {
    test("renames a playlist and returns 200 with the new name", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "patch-key-1");
      const playlist = await seedPlaylist({ userId: owner.id, title: "Old name" });

      const res = await client
        .patch(`/api/v1/playlists/${playlist.id}`)
        .set("Authorization", "Bearer patch-key-1")
        .send({ name: "New name" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: "New name" });

      const rows = await queryRows(
        "SELECT * FROM USER_PLAYLISTS WHERE id = :id",
        { id: playlist.id },
      );
      expect(rows[0].title).toBe("New name");
    });

    test("rejects a non-owner with 403", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "patch-key-2");
      await seedUserWithRoleAndKey("viewer", "patch-key-3");
      const playlist = await seedPlaylist({ userId: owner.id, title: "Old name" });

      const res = await client
        .patch(`/api/v1/playlists/${playlist.id}`)
        .set("Authorization", "Bearer patch-key-3")
        .send({ name: "Hijacked" });

      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /playlists/{id} (deletePlaylist)", () => {
    test("returns 200 and removes the playlist (items and access grants cascade)", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "delete-key-1");
      const grantee = await seedUserWithRoleAndKey("viewer", "delete-key-1b");
      const playlist = await seedPlaylist({ userId: owner.id, visibility: "private" });
      const upload = await seedUpload();
      await client
        .post(`/api/v1/playlists/${playlist.id}/items`)
        .set("Authorization", "Bearer delete-key-1")
        .send({ videoId: String(upload.id) });
      await seedPlaylistAccess({ playlistId: playlist.id, userId: grantee.id });

      const res = await client
        .delete(`/api/v1/playlists/${playlist.id}`)
        .set("Authorization", "Bearer delete-key-1");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });

      const playlistRows = await queryRows(
        "SELECT * FROM USER_PLAYLISTS WHERE id = :id",
        { id: playlist.id },
      );
      expect(playlistRows).toHaveLength(0);

      const itemRows = await queryRows(
        "SELECT * FROM PLAYLIST_ITEMS WHERE playlist_id = :playlistId",
        { playlistId: playlist.id },
      );
      expect(itemRows).toHaveLength(0);

      const accessRows = await queryRows(
        "SELECT * FROM PLAYLIST_ACCESS WHERE playlist_id = :playlistId",
        { playlistId: playlist.id },
      );
      expect(accessRows).toHaveLength(0);
    });

    test("rejects a non-owner with 403", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "delete-key-2");
      await seedUserWithRoleAndKey("viewer", "delete-key-3");
      const playlist = await seedPlaylist({ userId: owner.id });

      const res = await client
        .delete(`/api/v1/playlists/${playlist.id}`)
        .set("Authorization", "Bearer delete-key-3");

      expect(res.status).toBe(403);
    });
  });

  describe("POST /playlists/{id}/items (addPlaylistItem)", () => {
    test("adds a video and returns 200 with an incremented itemCount", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "add-key-1");
      const playlist = await seedPlaylist({ userId: owner.id });
      const upload = await seedUpload();

      const res = await client
        .post(`/api/v1/playlists/${playlist.id}/items`)
        .set("Authorization", "Bearer add-key-1")
        .send({ videoId: String(upload.id) });

      expect(res.status).toBe(200);
      expect(res.body.itemCount).toBe(1);

      const rows = await queryRows(
        "SELECT * FROM PLAYLIST_ITEMS WHERE playlist_id = :playlistId",
        { playlistId: playlist.id },
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].original_upload_id)).toBe(upload.id);
    });

    test("rejects adding the same video twice (unique constraint)", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "add-key-2");
      const playlist = await seedPlaylist({ userId: owner.id });
      const upload = await seedUpload();

      const first = await client
        .post(`/api/v1/playlists/${playlist.id}/items`)
        .set("Authorization", "Bearer add-key-2")
        .send({ videoId: String(upload.id) });
      expect(first.status).toBe(200);

      const second = await client
        .post(`/api/v1/playlists/${playlist.id}/items`)
        .set("Authorization", "Bearer add-key-2")
        .send({ videoId: String(upload.id) });
      expect(second.status).toBe(409);

      const rows = await queryRows(
        "SELECT * FROM PLAYLIST_ITEMS WHERE playlist_id = :playlistId",
        { playlistId: playlist.id },
      );
      expect(rows).toHaveLength(1);
    });

    test("rejects a non-owner with 403", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "add-key-3");
      await seedUserWithRoleAndKey("viewer", "add-key-4");
      const playlist = await seedPlaylist({ userId: owner.id });
      const upload = await seedUpload();

      const res = await client
        .post(`/api/v1/playlists/${playlist.id}/items`)
        .set("Authorization", "Bearer add-key-4")
        .send({ videoId: String(upload.id) });

      expect(res.status).toBe(403);
    });

    test("rejects adding an item to the owner's own 'My Likes' playlist with 403", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "add-key-5");
      const playlist = await seedPlaylist({
        userId: owner.id,
        title: "My Likes",
        kind: "likes",
      });
      const upload = await seedUpload();

      const res = await client
        .post(`/api/v1/playlists/${playlist.id}/items`)
        .set("Authorization", "Bearer add-key-5")
        .send({ videoId: String(upload.id) });

      expect(res.status).toBe(403);
      const rows = await queryRows(
        "SELECT * FROM PLAYLIST_ITEMS WHERE playlist_id = :playlistId",
        { playlistId: playlist.id },
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe("DELETE /playlists/{id}/items/{videoId} (removePlaylistItem)", () => {
    test("removes a video from the playlist and returns 200", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "remove-key-1");
      const playlist = await seedPlaylist({ userId: owner.id });
      const upload = await seedUpload();
      await client
        .post(`/api/v1/playlists/${playlist.id}/items`)
        .set("Authorization", "Bearer remove-key-1")
        .send({ videoId: String(upload.id) });

      const res = await client
        .delete(`/api/v1/playlists/${playlist.id}/items/${upload.id}`)
        .set("Authorization", "Bearer remove-key-1");

      expect(res.status).toBe(200);
      expect(res.body.itemCount).toBe(0);

      const rows = await queryRows(
        "SELECT * FROM PLAYLIST_ITEMS WHERE playlist_id = :playlistId",
        { playlistId: playlist.id },
      );
      expect(rows).toHaveLength(0);
    });

    test("rejects a non-owner with 403", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "remove-key-2");
      await seedUserWithRoleAndKey("viewer", "remove-key-3");
      const playlist = await seedPlaylist({ userId: owner.id });
      const upload = await seedUpload();
      await client
        .post(`/api/v1/playlists/${playlist.id}/items`)
        .set("Authorization", "Bearer remove-key-2")
        .send({ videoId: String(upload.id) });

      const res = await client
        .delete(`/api/v1/playlists/${playlist.id}/items/${upload.id}`)
        .set("Authorization", "Bearer remove-key-3");

      expect(res.status).toBe(403);
    });

    test("rejects removing an item from the owner's own 'My Likes' playlist with 403", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "remove-key-4");
      const playlist = await seedPlaylist({
        userId: owner.id,
        title: "My Likes",
        kind: "likes",
      });
      const upload = await seedUpload();
      await seedPlaylistItem(playlist.id, upload.id);

      const res = await client
        .delete(`/api/v1/playlists/${playlist.id}/items/${upload.id}`)
        .set("Authorization", "Bearer remove-key-4");

      expect(res.status).toBe(403);
      const rows = await queryRows(
        "SELECT * FROM PLAYLIST_ITEMS WHERE playlist_id = :playlistId",
        { playlistId: playlist.id },
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe("GET /playlists/{id}/access (listPlaylistAccess)", () => {
    test("returns 200 with granted users for the owner", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "list-access-key-1");
      const grantee = await seedUserWithRoleAndKey("viewer", "list-access-key-2", {
        username: "grantee_list",
      });
      const playlist = await seedPlaylist({ userId: owner.id, visibility: "private" });
      await seedPlaylistAccess({ playlistId: playlist.id, userId: grantee.id });

      const res = await client
        .get(`/api/v1/playlists/${playlist.id}/access`)
        .set("Authorization", "Bearer list-access-key-1");

      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([
        { userId: grantee.id, username: "grantee_list", displayName: null },
      ]);
    });

    test("rejects a non-owner with 403", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "list-access-key-3");
      await seedUserWithRoleAndKey("viewer", "list-access-key-4");
      const playlist = await seedPlaylist({ userId: owner.id, visibility: "private" });

      const res = await client
        .get(`/api/v1/playlists/${playlist.id}/access`)
        .set("Authorization", "Bearer list-access-key-4");

      expect(res.status).toBe(403);
    });
  });

  describe("POST /playlists/{id}/access (addPlaylistAccess)", () => {
    test("grants a user access and returns 200", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "add-access-key-1");
      const grantee = await seedUserWithRoleAndKey("viewer", "add-access-key-2", {
        username: "grantee_add",
      });
      const playlist = await seedPlaylist({ userId: owner.id, visibility: "private" });

      const res = await client
        .post(`/api/v1/playlists/${playlist.id}/access`)
        .set("Authorization", "Bearer add-access-key-1")
        .send({ username: "grantee_add" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        userId: grantee.id,
        username: "grantee_add",
        displayName: null,
        granted: true,
      });

      const rows = await queryRows(
        "SELECT * FROM PLAYLIST_ACCESS WHERE playlist_id = :playlistId",
        { playlistId: playlist.id },
      );
      expect(rows).toHaveLength(1);
    });

    test("is idempotent when the grant already exists", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "add-access-key-3");
      const grantee = await seedUserWithRoleAndKey("viewer", "add-access-key-4", {
        username: "grantee_idempotent",
      });
      const playlist = await seedPlaylist({ userId: owner.id, visibility: "private" });
      await seedPlaylistAccess({ playlistId: playlist.id, userId: grantee.id });

      const res = await client
        .post(`/api/v1/playlists/${playlist.id}/access`)
        .set("Authorization", "Bearer add-access-key-3")
        .send({ username: "grantee_idempotent" });

      expect(res.status).toBe(200);

      const rows = await queryRows(
        "SELECT * FROM PLAYLIST_ACCESS WHERE playlist_id = :playlistId",
        { playlistId: playlist.id },
      );
      expect(rows).toHaveLength(1);
    });

    test("rejects an unknown username with 404", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "add-access-key-5");
      const playlist = await seedPlaylist({ userId: owner.id, visibility: "private" });

      const res = await client
        .post(`/api/v1/playlists/${playlist.id}/access`)
        .set("Authorization", "Bearer add-access-key-5")
        .send({ username: "no_such_user" });

      expect(res.status).toBe(404);
    });

    test("rejects granting access to the playlist owner with 400", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "add-access-key-6", {
        username: "owner_self",
      });
      const playlist = await seedPlaylist({ userId: owner.id, visibility: "private" });

      const res = await client
        .post(`/api/v1/playlists/${playlist.id}/access`)
        .set("Authorization", "Bearer add-access-key-6")
        .send({ username: "owner_self" });

      expect(res.status).toBe(400);
    });

    test("rejects a non-owner with 403", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "add-access-key-7");
      await seedUserWithRoleAndKey("viewer", "add-access-key-8", {
        username: "grantee_forbidden",
      });
      await seedUserWithRoleAndKey("viewer", "add-access-key-9");
      const playlist = await seedPlaylist({ userId: owner.id, visibility: "private" });

      const res = await client
        .post(`/api/v1/playlists/${playlist.id}/access`)
        .set("Authorization", "Bearer add-access-key-9")
        .send({ username: "grantee_forbidden" });

      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /playlists/{id}/access/{userId} (removePlaylistAccess)", () => {
    test("revokes a user's access and returns 200", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "remove-access-key-1");
      const grantee = await seedUserWithRoleAndKey("viewer", "remove-access-key-2");
      const playlist = await seedPlaylist({ userId: owner.id, visibility: "private" });
      await seedPlaylistAccess({ playlistId: playlist.id, userId: grantee.id });

      const res = await client
        .delete(`/api/v1/playlists/${playlist.id}/access/${grantee.id}`)
        .set("Authorization", "Bearer remove-access-key-1");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        userId: grantee.id,
        username: grantee.username,
        displayName: null,
        granted: false,
      });

      const rows = await queryRows(
        "SELECT * FROM PLAYLIST_ACCESS WHERE playlist_id = :playlistId",
        { playlistId: playlist.id },
      );
      expect(rows).toHaveLength(0);
    });

    test("is idempotent when no grant exists", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "remove-access-key-3");
      const other = await seedUserWithRoleAndKey("viewer", "remove-access-key-4");
      const playlist = await seedPlaylist({ userId: owner.id, visibility: "private" });

      const res = await client
        .delete(`/api/v1/playlists/${playlist.id}/access/${other.id}`)
        .set("Authorization", "Bearer remove-access-key-3");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        userId: other.id,
        username: other.username,
        displayName: null,
        granted: false,
      });
    });

    test("rejects a non-owner with 403", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "remove-access-key-5");
      const grantee = await seedUserWithRoleAndKey("viewer", "remove-access-key-6");
      await seedUserWithRoleAndKey("viewer", "remove-access-key-7");
      const playlist = await seedPlaylist({ userId: owner.id, visibility: "private" });
      await seedPlaylistAccess({ playlistId: playlist.id, userId: grantee.id });

      const res = await client
        .delete(`/api/v1/playlists/${playlist.id}/access/${grantee.id}`)
        .set("Authorization", "Bearer remove-access-key-7");

      expect(res.status).toBe(403);
    });
  });
});
