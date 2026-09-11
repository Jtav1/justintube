import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import {
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
 * Seeds a user with an API key and returns a supertest client pre-set with
 * the Bearer Authorization header (skips CSRF entirely, same rationale as
 * the equivalent helper in me.test.js's "me / history routes" block).
 *
 * @param {string} suffix Unique-ish suffix for the username/email/key.
 * @returns {Promise<{user: object, get: Function, post: Function, delete: Function}>}
 */
async function seedAuthedClient(suffix) {
  const user = await seedUser({ username: `hide_${suffix}`, email: `hide_${suffix}@example.com` });
  const rawKey = `hide-test-key-${suffix}`;
  await seedUserApiKey(user.id, rawKey);
  const client = createTestClient();
  return {
    user,
    get: (url) => client.get(url).set("Authorization", `Bearer ${rawKey}`),
    post: (url) => client.post(url).set("Authorization", `Bearer ${rawKey}`),
    delete: (url) => client.delete(url).set("Authorization", `Bearer ${rawKey}`),
  };
}

describe("video hide/unhide routes", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("unauthenticated POST /videos/:id/hide returns 403 (CSRF check runs before auth for cookie-less requests)", async () => {
    const client = createTestClient();
    const res = await client.post("/api/v1/videos/1/hide");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("csrf_invalid");
  });

  test("unauthenticated DELETE /videos/:id/hide returns 403 (CSRF check runs before auth for cookie-less requests)", async () => {
    const client = createTestClient();
    const res = await client.delete("/api/v1/videos/1/hide");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("csrf_invalid");
  });

  test("POST /videos/:id/hide hides a viewable video, idempotently", async () => {
    const { user, post } = await seedAuthedClient("hide");
    const other = await seedUser({ username: "hide_owner", email: "hide_owner@example.com" });
    const upload = await seedUpload({ userId: other.id });
    await seedMetadata(upload.id, { visibility: "public" });

    const first = await post(`/api/v1/videos/${upload.id}/hide`);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ hidden: true });

    const second = await post(`/api/v1/videos/${upload.id}/hide`);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ hidden: true });
  });

  test("POST /videos/:id/hide rejects hiding your own video", async () => {
    const { user, post } = await seedAuthedClient("self");
    const upload = await seedUpload({ userId: user.id });
    await seedMetadata(upload.id, { visibility: "public" });

    const res = await post(`/api/v1/videos/${upload.id}/hide`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("POST /videos/:id/hide returns 404 for a video the caller cannot view", async () => {
    const { post } = await seedAuthedClient("noaccess");
    const other = await seedUser({ username: "hide_private_owner", email: "hide_private_owner@example.com" });
    const upload = await seedUpload({ userId: other.id });
    await seedMetadata(upload.id, { visibility: "private" });

    const res = await post(`/api/v1/videos/${upload.id}/hide`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("DELETE /videos/:id/hide unhides a video, idempotently when not hidden", async () => {
    const { post, delete: del } = await seedAuthedClient("unhide");
    const other = await seedUser({ username: "unhide_owner", email: "unhide_owner@example.com" });
    const upload = await seedUpload({ userId: other.id });
    await seedMetadata(upload.id, { visibility: "public" });

    await post(`/api/v1/videos/${upload.id}/hide`);

    const res = await del(`/api/v1/videos/${upload.id}/hide`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hidden: false });

    const again = await del(`/api/v1/videos/${upload.id}/hide`);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ hidden: false });
  });

  test("DELETE /videos/:id/hide accepts the public videoId, not just the numeric id", async () => {
    // The watch page only ever knows the public videoId from the URL - once
    // a video is masked as hidden_by_viewer it can't fetch the numeric id via
    // GET /videos/:id, so unhide must work from the videoId alone.
    const { post, delete: del, get } = await seedAuthedClient("videoid");
    const other = await seedUser({ username: "videoid_owner", email: "videoid_owner@example.com" });
    const upload = await seedUpload({ userId: other.id });
    await seedMetadata(upload.id, { title: "By videoId", visibility: "public" });

    await post(`/api/v1/videos/${upload.id}/hide`);

    const res = await del(`/api/v1/videos/${upload.videoId}/hide`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hidden: false });

    const after = await get(`/api/v1/videos/${upload.videoId}`);
    expect(after.status).toBe(200);
  });

  test("DELETE /videos/:id/hide is idempotent even for an identifier that doesn't resolve to any video", async () => {
    const { delete: del } = await seedAuthedClient("unresolvable");

    const res = await del("/api/v1/videos/nonexistent-video-id/hide");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hidden: false });
  });

  test("GET /videos/:id returns hidden_by_viewer once hidden, and normal data after unhiding", async () => {
    const { post, delete: del, get } = await seedAuthedClient("detail");
    const other = await seedUser({ username: "detail_owner", email: "detail_owner@example.com" });
    const upload = await seedUpload({ userId: other.id });
    await seedMetadata(upload.id, { title: "Detail video", visibility: "public" });

    const before = await get(`/api/v1/videos/${upload.id}`);
    expect(before.status).toBe(200);

    await post(`/api/v1/videos/${upload.id}/hide`);

    const hidden = await get(`/api/v1/videos/${upload.id}`);
    expect(hidden.status).toBe(404);
    expect(hidden.body.error).toBe("hidden_by_viewer");

    await del(`/api/v1/videos/${upload.id}/hide`);

    const after = await get(`/api/v1/videos/${upload.id}`);
    expect(after.status).toBe(200);
    expect(after.body.title).toBe("Detail video");
  });

  test("GET /videos excludes a video the caller has hidden", async () => {
    const { user, post, get } = await seedAuthedClient("listing");
    const other = await seedUser({ username: "listing_owner", email: "listing_owner@example.com" });

    const visible = await seedUpload({ userId: other.id });
    await seedMetadata(visible.id, { title: "Still shown", visibility: "public" });

    const hiddenUpload = await seedUpload({ userId: other.id });
    await seedMetadata(hiddenUpload.id, { title: "Hidden by viewer", visibility: "public" });
    await post(`/api/v1/videos/${hiddenUpload.id}/hide`);

    const res = await get("/api/v1/videos");
    expect(res.status).toBe(200);
    const titles = res.body.items.map((item) => item.title);
    expect(titles).toContain("Still shown");
    expect(titles).not.toContain("Hidden by viewer");
  });

  test("GET /users/:username/videos excludes a video the caller has hidden", async () => {
    const { post, get } = await seedAuthedClient("channel");
    const owner = await seedUser({ username: "channel_owner", email: "channel_owner@example.com" });

    const visible = await seedUpload({ userId: owner.id });
    await seedMetadata(visible.id, { title: "Channel visible", visibility: "public" });

    const hiddenUpload = await seedUpload({ userId: owner.id });
    await seedMetadata(hiddenUpload.id, { title: "Channel hidden", visibility: "public" });
    await post(`/api/v1/videos/${hiddenUpload.id}/hide`);

    const res = await get(`/api/v1/users/${owner.username}/videos`);
    expect(res.status).toBe(200);
    const titles = res.body.items.map((item) => item.title);
    expect(titles).toContain("Channel visible");
    expect(titles).not.toContain("Channel hidden");
  });

  test("GET /playlists/:id excludes an item the caller has hidden", async () => {
    const { post, get } = await seedAuthedClient("playlist");
    const owner = await seedUser({ username: "playlist_owner", email: "playlist_owner@example.com" });

    const visible = await seedUpload({ userId: owner.id });
    await seedMetadata(visible.id, { title: "Playlist visible", visibility: "public" });

    const hiddenUpload = await seedUpload({ userId: owner.id });
    await seedMetadata(hiddenUpload.id, { title: "Playlist hidden", visibility: "public" });
    await post(`/api/v1/videos/${hiddenUpload.id}/hide`);

    const playlist = await seedPlaylist({ userId: owner.id, visibility: "public" });
    await seedPlaylistItem(playlist.id, visible.id, { position: 1 });
    await seedPlaylistItem(playlist.id, hiddenUpload.id, { position: 2 });

    const res = await get(`/api/v1/playlists/${playlist.id}`);
    expect(res.status).toBe(200);
    const titles = res.body.items.map((item) => item.title);
    expect(titles).toContain("Playlist visible");
    expect(titles).not.toContain("Playlist hidden");
  });
});
