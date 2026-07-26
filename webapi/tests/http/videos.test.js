import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "@jest/globals";
import { mediaDir } from "../../lib/media-meta.js";
import { Role } from "../../lib/models/index.js";
import { createTestAgent, createTestClient } from "../helpers/app.js";
import {
  queryRows,
  resetTables,
  seedContentTag,
  seedFeaturedVideo,
  seedFileVersion,
  seedMetadata,
  seedSubscription,
  seedUpload,
  seedUser,
  seedUserApiKey,
  seedVideoAccess,
  seedVideoThumbnail,
  setupSchema,
} from "../helpers/db.js";

/**
 * Writes a fixture file under the test media root at a given relative storage
 * path (e.g. "transcoded/foo.mp4"), creating parent directories as needed.
 *
 * @param {string} relativeStoragePath Path relative to `mediaDir`.
 * @param {Buffer} contents File contents to write.
 * @returns {string} The absolute path the file was written to.
 */
function writeMediaFixture(relativeStoragePath, contents) {
  const absolutePath = join(mediaDir, relativeStoragePath);
  mkdirSync(join(absolutePath, ".."), { recursive: true });
  writeFileSync(absolutePath, contents);
  return absolutePath;
}

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
 * HTTP contract tests for video discovery, metadata, engagement, and access.
 */
describe("Video discovery and metadata endpoints", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  describe("GET /videos/{id} (getVideo)", () => {
    test("returns 200 with watch metadata for an existing public video", async () => {
      const upload = await seedUpload();
      await seedMetadata(upload.id, {
        title: "Watchable",
        description: "A described clip",
        visibility: "public",
        commentsEnabled: 1,
      });

      const res = await client.get(`/api/v1/videos/${upload.id}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: upload.id,
        title: "Watchable",
        description: "A described clip",
        visibility: "public",
        commentsEnabled: true,
      });
    });

    test("returns 404 for an unknown video id", async () => {
      const res = await client.get("/api/v1/videos/999999");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });

    test("returns 404 for private videos without access", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "owner-key-1");
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id, {
        title: "Secret",
        visibility: "private",
      });

      const res = await client.get(`/api/v1/videos/${upload.id}`);

      expect(res.status).toBe(404);
    });

    test("allows private videos for access grantees", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "owner-key-2");
      const grantee = await seedUserWithRoleAndKey("viewer", "grantee-key-1", {
        username: "grantee1",
      });
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id, {
        title: "Shared private",
        visibility: "private",
      });
      await seedVideoAccess(upload.id, grantee.id);

      const res = await client
        .get(`/api/v1/videos/${upload.id}`)
        .set("Authorization", "Bearer grantee-key-1");

      expect(res.status).toBe(200);
      expect(res.body.title).toBe("Shared private");
    });

    test("includes durationSeconds, thumbnailUrl, and complete renditions", async () => {
      const upload = await seedUpload({ durationSeconds: 125 });
      await seedMetadata(upload.id, { title: "Enriched", visibility: "public" });
      await seedVideoThumbnail(upload.id);
      await seedFileVersion(upload.id, {
        status: "complete",
        resolution: "480p",
        videoWidth: 854,
        videoHeight: 480,
      });
      await seedFileVersion(upload.id, {
        status: "pending",
        resolution: "1080p",
        videoWidth: 1920,
        videoHeight: 1080,
      });

      const res = await client.get(`/api/v1/videos/${upload.id}`);

      expect(res.status).toBe(200);
      expect(res.body.durationSeconds).toBe(125);
      expect(res.body.thumbnailUrl).toBe(`/api/v1/videos/${upload.id}/thumbnail`);
      expect(res.body.renditions).toEqual([
        { resolution: "480p", width: 854, height: 480 },
      ]);
    });
  });

  describe("GET /videos/{id}/stream (getVideoStream)", () => {
    test("streams the highest-resolution complete rendition with 200 when no Range header is sent", async () => {
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });
      const smallContents = Buffer.from("x".repeat(100));
      const largeContents = Buffer.from("y".repeat(200));
      await seedFileVersion(upload.id, {
        status: "complete",
        resolution: "480p",
        videoHeight: 480,
        mimeType: "video/mp4",
        storagePath: `transcoded/${upload.uuidName}-480p.mp4`,
      });
      writeMediaFixture(`transcoded/${upload.uuidName}-480p.mp4`, smallContents);
      await seedFileVersion(upload.id, {
        status: "complete",
        resolution: "720p",
        videoHeight: 720,
        mimeType: "video/mp4",
        storagePath: `transcoded/${upload.uuidName}-720p.mp4`,
      });
      writeMediaFixture(`transcoded/${upload.uuidName}-720p.mp4`, largeContents);

      const res = await client
        .get(`/api/v1/videos/${upload.id}/stream`)
        .buffer(true)
        .parse((response, callback) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => callback(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("video/mp4");
      expect(res.headers["accept-ranges"]).toBe("bytes");
      expect(Number(res.headers["content-length"])).toBe(largeContents.length);
      expect(Buffer.compare(res.body, largeContents)).toBe(0);
    });

    test("honors a Range header with 206 partial content", async () => {
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });
      const contents = Buffer.from("0123456789");
      await seedFileVersion(upload.id, {
        status: "complete",
        resolution: "480p",
        videoHeight: 480,
        mimeType: "video/mp4",
        storagePath: `transcoded/${upload.uuidName}.mp4`,
      });
      writeMediaFixture(`transcoded/${upload.uuidName}.mp4`, contents);

      const res = await client
        .get(`/api/v1/videos/${upload.id}/stream`)
        .set("Range", "bytes=2-4")
        .buffer(true)
        .parse((response, callback) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => callback(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(206);
      expect(res.headers["content-range"]).toBe("bytes 2-4/10");
      expect(res.body.toString()).toBe("234");
    });

    test("selects a rendition by ?quality=", async () => {
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });
      const small = Buffer.from("small-480p");
      const large = Buffer.from("large-720p");
      await seedFileVersion(upload.id, {
        status: "complete",
        resolution: "480p",
        videoHeight: 480,
        mimeType: "video/mp4",
        storagePath: `transcoded/${upload.uuidName}-480p.mp4`,
      });
      writeMediaFixture(`transcoded/${upload.uuidName}-480p.mp4`, small);
      await seedFileVersion(upload.id, {
        status: "complete",
        resolution: "720p",
        videoHeight: 720,
        mimeType: "video/mp4",
        storagePath: `transcoded/${upload.uuidName}-720p.mp4`,
      });
      writeMediaFixture(`transcoded/${upload.uuidName}-720p.mp4`, large);

      const res = await client
        .get(`/api/v1/videos/${upload.id}/stream?quality=480p`)
        .buffer(true)
        .parse((response, callback) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => callback(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(Buffer.compare(res.body, small)).toBe(0);
    });

    test("returns 404 for an unknown quality label", async () => {
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });
      await seedFileVersion(upload.id, {
        status: "complete",
        resolution: "480p",
        videoHeight: 480,
        storagePath: `transcoded/${upload.uuidName}.mp4`,
      });
      writeMediaFixture(`transcoded/${upload.uuidName}.mp4`, Buffer.from("data"));

      const res = await client.get(`/api/v1/videos/${upload.id}/stream?quality=1080p`);

      expect(res.status).toBe(404);
    });

    test("returns 404 when no complete renditions exist", async () => {
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });
      await seedFileVersion(upload.id, { status: "pending" });

      const res = await client.get(`/api/v1/videos/${upload.id}/stream`);

      expect(res.status).toBe(404);
    });

    test("returns 404 for a private video without access", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "stream-owner-key");
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id, { visibility: "private" });
      await seedFileVersion(upload.id, {
        status: "complete",
        storagePath: `transcoded/${upload.uuidName}.mp4`,
      });
      writeMediaFixture(`transcoded/${upload.uuidName}.mp4`, Buffer.from("data"));

      const res = await client.get(`/api/v1/videos/${upload.id}/stream`);

      expect(res.status).toBe(404);
    });
  });

  describe("GET /videos/{id}/thumbnail (getVideoThumbnail)", () => {
    test("serves the thumbnail image for a public video", async () => {
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });
      const thumbnail = await seedVideoThumbnail(upload.id, {
        thumbnailFilename: `${upload.uuidName}.jpg`,
      });
      const contents = Buffer.from("fake-jpeg-bytes");
      writeMediaFixture(`thumbnails/${thumbnail.thumbnailFilename}`, contents);

      const res = await client
        .get(`/api/v1/videos/${upload.id}/thumbnail`)
        .buffer(true)
        .parse((response, callback) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => callback(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("image/jpeg");
      expect(Buffer.compare(res.body, contents)).toBe(0);
    });

    test("returns 404 when no thumbnail has been generated", async () => {
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });

      const res = await client.get(`/api/v1/videos/${upload.id}/thumbnail`);

      expect(res.status).toBe(404);
    });

    test("returns 404 for a private video without access", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "thumb-owner-key");
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id, { visibility: "private" });
      const thumbnail = await seedVideoThumbnail(upload.id);
      writeMediaFixture(`thumbnails/${thumbnail.thumbnailFilename}`, Buffer.from("x"));

      const res = await client.get(`/api/v1/videos/${upload.id}/thumbnail`);

      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /videos/{id} (updateVideo)", () => {
    test("rejects unauthenticated updates", async () => {
      const upload = await seedUpload();
      await seedMetadata(upload.id, { title: "Before" });

      const res = await client
        .patch(`/api/v1/videos/${upload.id}`)
        .set("Authorization", "Bearer jt_not_a_real_key")
        .send({
          title: "After",
        });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("unauthorized");
    });

    test("updates editable metadata and returns 200 with the new values", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "owner-update-key");
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id, {
        title: "Before",
        visibility: "private",
        commentsEnabled: 1,
      });

      const res = await client
        .patch(`/api/v1/videos/${upload.id}`)
        .set("Authorization", "Bearer owner-update-key")
        .send({
          title: "After",
          visibility: "unlisted",
          commentsEnabled: false,
        });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        title: "After",
        visibility: "unlisted",
        commentsEnabled: false,
      });

      const rows = await queryRows(
        "SELECT * FROM VIDEO_METADATA WHERE original_upload_id = :id",
        { id: upload.id },
      );
      expect(rows[0].title).toBe("After");
      expect(rows[0].visibility).toBe("unlisted");
      expect(rows[0].comments_enabled).toBe(0);
    });

    test("forbids non-owners from updating", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "owner-forbid-key");
      await seedUserWithRoleAndKey("viewer", "other-forbid-key");
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id, { title: "Mine" });

      const res = await client
        .patch(`/api/v1/videos/${upload.id}`)
        .set("Authorization", "Bearer other-forbid-key")
        .send({ title: "Hijacked" });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });
  });

  describe("DELETE /videos/{id} (deleteVideo)", () => {
    test("rejects unauthenticated deletes", async () => {
      const upload = await seedUpload();
      await seedMetadata(upload.id);

      const res = await client
        .delete(`/api/v1/videos/${upload.id}`)
        .set("Authorization", "Bearer jt_not_a_real_key");

      expect(res.status).toBe(401);
    });

    test("returns 204 and removes the upload (and its metadata via cascade)", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "owner-delete-key");
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id);

      const res = await client
        .delete(`/api/v1/videos/${upload.id}`)
        .set("Authorization", "Bearer owner-delete-key");

      expect(res.status).toBe(204);

      const uploads = await queryRows(
        "SELECT * FROM ORIGINAL_UPLOADS WHERE id = :id",
        { id: upload.id },
      );
      expect(uploads).toHaveLength(0);

      const metadata = await queryRows(
        "SELECT * FROM VIDEO_METADATA WHERE original_upload_id = :id",
        { id: upload.id },
      );
      expect(metadata).toHaveLength(0);
    });
  });

  describe("GET /videos (listVideos)", () => {
    test("returns 200 VideoList excluding non-public videos for public viewers", async () => {
      const publicUpload = await seedUpload({ originalFilename: "public.mp4" });
      await seedMetadata(publicUpload.id, {
        title: "Public one",
        visibility: "public",
      });
      const privateUpload = await seedUpload({
        originalFilename: "private.mp4",
      });
      await seedMetadata(privateUpload.id, {
        title: "Private one",
        visibility: "private",
      });

      const res = await client.get("/api/v1/videos");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      const titles = res.body.items.map((item) => item.title);
      expect(titles).toContain("Public one");
      expect(titles).not.toContain("Private one");
    });
  });

  describe("GET /videos/featured and /videos/newest", () => {
    test("lists only featured public videos", async () => {
      const featured = await seedUpload({ originalFilename: "feat.mp4" });
      await seedMetadata(featured.id, {
        title: "Featured public",
        visibility: "public",
      });
      await seedFeaturedVideo(featured.id);

      const other = await seedUpload({ originalFilename: "other.mp4" });
      await seedMetadata(other.id, {
        title: "Not featured",
        visibility: "public",
      });

      const privateFeatured = await seedUpload({
        originalFilename: "priv-feat.mp4",
      });
      await seedMetadata(privateFeatured.id, {
        title: "Featured private",
        visibility: "private",
      });
      await seedFeaturedVideo(privateFeatured.id);

      const res = await client.get("/api/v1/videos/featured");

      expect(res.status).toBe(200);
      const titles = res.body.items.map((item) => item.title);
      expect(titles).toContain("Featured public");
      expect(titles).not.toContain("Not featured");
      expect(titles).not.toContain("Featured private");
    });

    test("lists newest public videos", async () => {
      const older = await seedUpload({ originalFilename: "old.mp4" });
      await seedMetadata(older.id, {
        title: "Older",
        visibility: "public",
      });
      const newer = await seedUpload({ originalFilename: "new.mp4" });
      await seedMetadata(newer.id, {
        title: "Newer",
        visibility: "public",
      });

      const res = await client.get("/api/v1/videos/newest");

      expect(res.status).toBe(200);
      expect(res.body.items.map((item) => item.title)).toEqual(
        expect.arrayContaining(["Newer", "Older"]),
      );
    });
  });

  describe("POST /videos/{id}/delist (delistVideo)", () => {
    test("sets visibility to hidden for moderators", async () => {
      await seedUserWithRoleAndKey("moderator", "mod-delist-key");
      const upload = await seedUpload();
      await seedMetadata(upload.id, {
        title: "To delist",
        visibility: "public",
      });

      const res = await client
        .post(`/api/v1/videos/${upload.id}/delist`)
        .set("Authorization", "Bearer mod-delist-key");

      expect(res.status).toBe(200);
      expect(res.body.visibility).toBe("hidden");
    });

    test("forbids viewers from delisting", async () => {
      await seedUserWithRoleAndKey("viewer", "viewer-delist-key");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });

      const res = await client
        .post(`/api/v1/videos/${upload.id}/delist`)
        .set("Authorization", "Bearer viewer-delist-key");

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });
  });

  describe("video access grants", () => {
    test("owner can set and list access by username", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "owner-access-key");
      const friend = await seedUser({ username: "friend_user" });
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id, { visibility: "private" });

      const putRes = await client
        .put(`/api/v1/videos/${upload.id}/access`)
        .set("Authorization", "Bearer owner-access-key")
        .send({ usernames: ["friend_user"] });

      expect(putRes.status).toBe(200);
      expect(putRes.body.items).toEqual([
        { userId: friend.id, username: "friend_user" },
      ]);

      const getRes = await client
        .get(`/api/v1/videos/${upload.id}/access`)
        .set("Authorization", "Bearer owner-access-key");

      expect(getRes.status).toBe(200);
      expect(getRes.body.items).toHaveLength(1);
      expect(getRes.body.items[0].username).toBe("friend_user");
    });

    test("rejects unknown usernames", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "owner-bad-access");
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id, { visibility: "private" });

      const res = await client
        .put(`/api/v1/videos/${upload.id}/access`)
        .set("Authorization", "Bearer owner-bad-access")
        .send({ usernames: ["no_such_user"] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_body");
    });
  });

  describe("views and likes", () => {
    test("increments viewCount for public videos", async () => {
      const upload = await seedUpload();
      await seedMetadata(upload.id, {
        title: "Views",
        visibility: "public",
        viewCount: 2,
      });

      const agent = createTestAgent();
      const csrf = await agent.get("/api/v1/auth/csrf");
      const res = await agent
        .post(`/api/v1/videos/${upload.id}/view`)
        .set("X-CSRF-Token", csrf.body.csrfToken);

      expect(res.status).toBe(200);
      expect(res.body.viewCount).toBe(3);
    });

    test("likes and dislikes require auth and persist VIDEO_LIKES", async () => {
      const viewer = await seedUserWithRoleAndKey("viewer", "like-key-1");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });

      const likeRes = await client
        .post(`/api/v1/videos/${upload.id}/like`)
        .set("Authorization", "Bearer like-key-1");
      expect(likeRes.status).toBe(200);
      expect(likeRes.body).toEqual({ liked: true });

      const likes = await queryRows(
        "SELECT * FROM VIDEO_LIKES WHERE original_upload_id = :id AND user_id = :userId",
        { id: upload.id, userId: viewer.id },
      );
      expect(likes).toHaveLength(1);

      const dislikeRes = await client
        .post(`/api/v1/videos/${upload.id}/dislike`)
        .set("Authorization", "Bearer like-key-1");
      expect(dislikeRes.status).toBe(200);
      expect(dislikeRes.body).toEqual({ liked: false });

      const after = await queryRows(
        "SELECT * FROM VIDEO_LIKES WHERE original_upload_id = :id AND user_id = :userId",
        { id: upload.id, userId: viewer.id },
      );
      expect(after).toHaveLength(0);
    });
  });

  describe("tags", () => {
    test("lists tags from public videos with counts", async () => {
      const a = await seedUpload({ originalFilename: "a.mp4" });
      await seedMetadata(a.id, { title: "A", visibility: "public" });
      await seedContentTag(a.id, { tag: "gaming" });

      const b = await seedUpload({ originalFilename: "b.mp4" });
      await seedMetadata(b.id, { title: "B", visibility: "public" });
      await seedContentTag(b.id, { tag: "gaming" });

      const priv = await seedUpload({ originalFilename: "p.mp4" });
      await seedMetadata(priv.id, { title: "P", visibility: "private" });
      await seedContentTag(priv.id, { tag: "secret" });

      const res = await client.get("/api/v1/tags");

      expect(res.status).toBe(200);
      expect(res.body.items).toEqual(
        expect.arrayContaining([{ tag: "gaming", videoCount: 2 }]),
      );
      expect(res.body.items.map((item) => item.tag)).not.toContain("secret");
    });

    test("lists public videos for a tag", async () => {
      const upload = await seedUpload();
      await seedMetadata(upload.id, {
        title: "Tagged",
        visibility: "public",
      });
      await seedContentTag(upload.id, { tag: "music" });

      const res = await client.get("/api/v1/tags/music/videos");

      expect(res.status).toBe(200);
      expect(res.body.items.map((item) => item.title)).toContain("Tagged");
    });
  });

  describe("GET /feed/subscriptions (feedSubscriptions)", () => {
    test("requires auth", async () => {
      const res = await client
        .get("/api/v1/feed/subscriptions")
        .set("Authorization", "Bearer jt_not_a_real_key");
      expect(res.status).toBe(401);
    });

    test("returns public videos from subscribed channels", async () => {
      const viewer = await seedUserWithRoleAndKey("viewer", "feed-key-1");
      const channel = await seedUser({ username: "channel_one" });
      await seedSubscription(viewer.id, channel.id);

      const upload = await seedUpload({ userId: channel.id });
      await seedMetadata(upload.id, {
        title: "From channel",
        visibility: "public",
      });

      const privateUpload = await seedUpload({
        userId: channel.id,
        originalFilename: "priv.mp4",
      });
      await seedMetadata(privateUpload.id, {
        title: "Private channel clip",
        visibility: "private",
      });

      const res = await client
        .get("/api/v1/feed/subscriptions")
        .set("Authorization", "Bearer feed-key-1");

      expect(res.status).toBe(200);
      const titles = res.body.items.map((item) => item.title);
      expect(titles).toContain("From channel");
      expect(titles).not.toContain("Private channel clip");
    });
  });
});
