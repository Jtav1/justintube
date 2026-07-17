import { createTestClient } from "../helpers/app.js";
import {
  queryRows,
  resetTables,
  seedPlaylist,
  seedUpload,
  setupSchema,
} from "../helpers/db.js";

/**
 * HTTP contract tests for playlist endpoints backed by USER_PLAYLISTS and
 * PLAYLIST_ITEMS. These are RED / TDD specs: the routes are currently 501
 * stubs, so they define the intended behavior for a future implementation.
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
    test("creates a playlist and returns 201 with the Playlist", async () => {
      const res = await client.post("/api/v1/playlists").send({
        name: "Favourites",
        description: "Stuff I like",
        visibility: "private",
      });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: "Favourites",
        visibility: "private",
      });
      expect(res.body.id).toBeDefined();

      const rows = await queryRows("SELECT * FROM USER_PLAYLISTS");
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe("Favourites");
    });

    test("rejects a request missing the required name with 400", async () => {
      const res = await client
        .post("/api/v1/playlists")
        .send({ description: "no name" });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /playlists/{id} (getPlaylist)", () => {
    test("returns 200 with the playlist, its items and itemCount", async () => {
      const playlist = await seedPlaylist({ title: "Mix" });

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
  });

  describe("PATCH /playlists/{id} (updatePlaylist)", () => {
    test("renames a playlist and returns 200 with the new name", async () => {
      const playlist = await seedPlaylist({ title: "Old name" });

      const res = await client
        .patch(`/api/v1/playlists/${playlist.id}`)
        .send({ name: "New name" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: "New name" });

      const rows = await queryRows(
        "SELECT * FROM USER_PLAYLISTS WHERE id = :id",
        { id: playlist.id },
      );
      expect(rows[0].title).toBe("New name");
    });
  });

  describe("DELETE /playlists/{id} (deletePlaylist)", () => {
    test("returns 204 and removes the playlist (items cascade)", async () => {
      const playlist = await seedPlaylist();

      const res = await client.delete(`/api/v1/playlists/${playlist.id}`);

      expect(res.status).toBe(204);

      const rows = await queryRows(
        "SELECT * FROM USER_PLAYLISTS WHERE id = :id",
        { id: playlist.id },
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe("POST /playlists/{id}/items (addPlaylistItem)", () => {
    test("adds a video and returns 200 with an incremented itemCount", async () => {
      const playlist = await seedPlaylist();
      const upload = await seedUpload();

      const res = await client
        .post(`/api/v1/playlists/${playlist.id}/items`)
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
      const playlist = await seedPlaylist();
      const upload = await seedUpload();

      const first = await client
        .post(`/api/v1/playlists/${playlist.id}/items`)
        .send({ videoId: String(upload.id) });
      expect(first.status).toBe(200);

      const second = await client
        .post(`/api/v1/playlists/${playlist.id}/items`)
        .send({ videoId: String(upload.id) });
      expect(second.status).toBe(409);

      const rows = await queryRows(
        "SELECT * FROM PLAYLIST_ITEMS WHERE playlist_id = :playlistId",
        { playlistId: playlist.id },
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe("DELETE /playlists/{id}/items/{videoId} (removePlaylistItem)", () => {
    test("removes a video from the playlist and returns 200", async () => {
      const playlist = await seedPlaylist();
      const upload = await seedUpload();
      await client
        .post(`/api/v1/playlists/${playlist.id}/items`)
        .send({ videoId: String(upload.id) });

      const res = await client.delete(
        `/api/v1/playlists/${playlist.id}/items/${upload.id}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.itemCount).toBe(0);

      const rows = await queryRows(
        "SELECT * FROM PLAYLIST_ITEMS WHERE playlist_id = :playlistId",
        { playlistId: playlist.id },
      );
      expect(rows).toHaveLength(0);
    });
  });
});
