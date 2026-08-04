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
import { NotificationType, Role } from "../../lib/models/index.js";
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
  seedUserNotificationSetting,
  seedUserViewHistory,
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
        videoId: upload.videoId,
        title: "Watchable",
        description: "A described clip",
        visibility: "public",
        commentsEnabled: true,
        mediaType: "video",
      });
    });

    test("includes featured only for admin callers", async () => {
      await seedUserWithRoleAndKey("admin", "admin-getvideo-featured-key");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { title: "Featured check", visibility: "public" });
      await seedFeaturedVideo(upload.id);

      const anonRes = await client.get(`/api/v1/videos/${upload.id}`);
      expect(anonRes.body.featured).toBeUndefined();

      await seedUserWithRoleAndKey("viewer", "viewer-getvideo-featured-key");
      const viewerRes = await client
        .get(`/api/v1/videos/${upload.id}`)
        .set("Authorization", "Bearer viewer-getvideo-featured-key");
      expect(viewerRes.body.featured).toBeUndefined();

      const adminRes = await client
        .get(`/api/v1/videos/${upload.id}`)
        .set("Authorization", "Bearer admin-getvideo-featured-key");
      expect(adminRes.body.featured).toBe(true);
    });

    test("returns 200 for the same video looked up by videoId", async () => {
      const upload = await seedUpload();
      await seedMetadata(upload.id, { title: "Watchable by videoId", visibility: "public" });

      const res = await client.get(`/api/v1/videos/${upload.videoId}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: upload.id,
        videoId: upload.videoId,
        title: "Watchable by videoId",
      });
    });

    test("distinguishes videoIds that differ only in case", async () => {
      const lower = await seedUpload({ videoId: "abcdef" });
      await seedMetadata(lower.id, { title: "Lowercase", visibility: "public" });
      const upper = await seedUpload({ videoId: "ABCDEF" });
      await seedMetadata(upper.id, { title: "Uppercase", visibility: "public" });

      const lowerRes = await client.get(`/api/v1/videos/${lower.videoId}`);
      const upperRes = await client.get(`/api/v1/videos/${upper.videoId}`);

      expect(lowerRes.body.title).toBe("Lowercase");
      expect(upperRes.body.title).toBe("Uppercase");
    });

    test("returns 404 for an unknown videoId", async () => {
      const res = await client.get("/api/v1/videos/zzzzzz");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
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

    test("returns 404 for hidden videos to a stranger", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "owner-hidden-key-1");
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id, { title: "Hidden", visibility: "hidden" });

      const res = await client.get(`/api/v1/videos/${upload.id}`);

      expect(res.status).toBe(404);
    });

    test("returns 200 for a hidden video to its owner", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "owner-hidden-key-2");
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id, { title: "Hidden", visibility: "hidden" });

      const res = await client
        .get(`/api/v1/videos/${upload.id}`)
        .set("Authorization", "Bearer owner-hidden-key-2");

      expect(res.status).toBe(200);
      expect(res.body.title).toBe("Hidden");
    });

    test("returns 200 for a hidden video to a VIDEO_ACCESS grantee", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "owner-hidden-key-3");
      const grantee = await seedUserWithRoleAndKey("viewer", "grantee-hidden-key-1", {
        username: "hiddengrantee1",
      });
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id, { title: "Hidden shared", visibility: "hidden" });
      await seedVideoAccess(upload.id, grantee.id);

      const res = await client
        .get(`/api/v1/videos/${upload.id}`)
        .set("Authorization", "Bearer grantee-hidden-key-1");

      expect(res.status).toBe(200);
      expect(res.body.title).toBe("Hidden shared");
    });

    test("includes durationSeconds, thumbnailUrl, and complete renditions", async () => {
      const upload = await seedUpload({ durationSeconds: 125 });
      await seedMetadata(upload.id, { title: "Enriched", visibility: "public" });
      await seedVideoThumbnail(upload.id);
      const complete = await seedFileVersion(upload.id, {
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
        {
          id: complete.id,
          resolution: "480p",
          width: 854,
          height: 480,
          mimeType: "video/mp4",
          fileSizeBytes: 1024,
          streamUrl: `/api/v1/videos/${upload.id}/stream?quality=480p`,
        },
        {
          id: upload.id,
          resolution: "original",
          width: null,
          height: null,
          mimeType: "video/mp4",
          fileSizeBytes: 2048,
          streamUrl: `/api/v1/videos/${upload.id}/stream?quality=original`,
        },
      ]);
      expect(res.body.tags).toEqual([]);
    });

    test("includes an original rendition even when no complete transcodes exist", async () => {
      const upload = await seedUpload();
      await seedMetadata(upload.id, { title: "Untranscoded", visibility: "public" });

      const res = await client.get(`/api/v1/videos/${upload.id}`);

      expect(res.status).toBe(200);
      expect(res.body.renditions).toEqual([
        {
          id: upload.id,
          resolution: "original",
          width: null,
          height: null,
          mimeType: "video/mp4",
          fileSizeBytes: 2048,
          streamUrl: `/api/v1/videos/${upload.id}/stream?quality=original`,
        },
      ]);
    });

    test("includes this video's own tags", async () => {
      const upload = await seedUpload();
      await seedMetadata(upload.id, { title: "Tagged", visibility: "public" });
      await seedContentTag(upload.id, { tag: "gaming" });
      await seedContentTag(upload.id, { tag: "co-op" });

      const res = await client.get(`/api/v1/videos/${upload.id}`);

      expect(res.status).toBe(200);
      expect(res.body.tags.sort()).toEqual(["co-op", "gaming"]);
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
        storagePath: `transcoded/${upload.videoId}-480p.mp4`,
      });
      writeMediaFixture(`transcoded/${upload.videoId}-480p.mp4`, smallContents);
      await seedFileVersion(upload.id, {
        status: "complete",
        resolution: "720p",
        videoHeight: 720,
        mimeType: "video/mp4",
        storagePath: `transcoded/${upload.videoId}-720p.mp4`,
      });
      writeMediaFixture(`transcoded/${upload.videoId}-720p.mp4`, largeContents);

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
        storagePath: `transcoded/${upload.videoId}.mp4`,
      });
      writeMediaFixture(`transcoded/${upload.videoId}.mp4`, contents);

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
        storagePath: `transcoded/${upload.videoId}-480p.mp4`,
      });
      writeMediaFixture(`transcoded/${upload.videoId}-480p.mp4`, small);
      await seedFileVersion(upload.id, {
        status: "complete",
        resolution: "720p",
        videoHeight: 720,
        mimeType: "video/mp4",
        storagePath: `transcoded/${upload.videoId}-720p.mp4`,
      });
      writeMediaFixture(`transcoded/${upload.videoId}-720p.mp4`, large);

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
        storagePath: `transcoded/${upload.videoId}.mp4`,
      });
      writeMediaFixture(`transcoded/${upload.videoId}.mp4`, Buffer.from("data"));

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

    test("streams the original upload's file for ?quality=original", async () => {
      const originalContents = Buffer.from("the-original-source-file");
      const upload = await seedUpload({
        storagePath: "original/source.mp4",
        mimeType: "video/mp4",
      });
      await seedMetadata(upload.id, { visibility: "public" });
      await seedFileVersion(upload.id, {
        status: "complete",
        resolution: "480p",
        videoHeight: 480,
        storagePath: `transcoded/${upload.videoId}-480p.mp4`,
      });
      writeMediaFixture(`transcoded/${upload.videoId}-480p.mp4`, Buffer.from("transcoded"));
      writeMediaFixture("original/source.mp4", originalContents);

      const res = await client
        .get(`/api/v1/videos/${upload.id}/stream?quality=original`)
        .buffer(true)
        .parse((response, callback) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => callback(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("video/mp4");
      expect(Buffer.compare(res.body, originalContents)).toBe(0);
    });

    test("streams the original upload's file for ?quality=original even with no complete renditions", async () => {
      const originalContents = Buffer.from("only-the-original-exists");
      const upload = await seedUpload({
        storagePath: "original/only.mp4",
        mimeType: "video/mp4",
      });
      await seedMetadata(upload.id, { visibility: "public" });
      writeMediaFixture("original/only.mp4", originalContents);

      const res = await client
        .get(`/api/v1/videos/${upload.id}/stream?quality=original`)
        .buffer(true)
        .parse((response, callback) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => callback(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(Buffer.compare(res.body, originalContents)).toBe(0);
    });

    test("returns 404 for a private video without access", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "stream-owner-key");
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id, { visibility: "private" });
      await seedFileVersion(upload.id, {
        status: "complete",
        storagePath: `transcoded/${upload.videoId}.mp4`,
      });
      writeMediaFixture(`transcoded/${upload.videoId}.mp4`, Buffer.from("data"));

      const res = await client.get(`/api/v1/videos/${upload.id}/stream`);

      expect(res.status).toBe(404);
    });
  });

  describe("GET /videos/{id}/thumbnail (getVideoThumbnail)", () => {
    test("serves the thumbnail image for a public video", async () => {
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });
      const thumbnail = await seedVideoThumbnail(upload.id, {
        thumbnailFilename: `${upload.videoId}.jpg`,
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

    test("response includes tags and complete renditions, same as getVideo", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "owner-update-shape-key");
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id, { title: "Before", visibility: "public" });
      await seedContentTag(upload.id, { tag: "existing" });
      const complete = await seedFileVersion(upload.id, {
        status: "complete",
        resolution: "480p",
        videoWidth: 854,
        videoHeight: 480,
      });

      const res = await client
        .patch(`/api/v1/videos/${upload.id}`)
        .set("Authorization", "Bearer owner-update-shape-key")
        .send({ tags: ["new-tag"] });

      expect(res.status).toBe(200);
      expect(res.body.tags).toEqual(["new-tag"]);
      expect(res.body.renditions).toEqual([
        {
          id: complete.id,
          resolution: "480p",
          width: 854,
          height: 480,
          mimeType: "video/mp4",
          fileSizeBytes: 1024,
          streamUrl: `/api/v1/videos/${upload.id}/stream?quality=480p`,
        },
        {
          id: upload.id,
          resolution: "original",
          width: null,
          height: null,
          mimeType: "video/mp4",
          fileSizeBytes: 2048,
          streamUrl: `/api/v1/videos/${upload.id}/stream?quality=original`,
        },
      ]);
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

    test("returns 200 and removes the upload (and its metadata via cascade)", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "owner-delete-key");
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id);

      const res = await client
        .delete(`/api/v1/videos/${upload.id}`)
        .set("Authorization", "Bearer owner-delete-key");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });

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

      await seedContentTag(publicUpload.id, { tag: "vlog" });

      const res = await client.get("/api/v1/videos");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      const titles = res.body.items.map((item) => item.title);
      expect(titles).toContain("Public one");
      expect(titles).not.toContain("Private one");

      const publicItem = res.body.items.find((item) => item.title === "Public one");
      expect(publicItem.tags).toEqual(["vlog"]);
    });

    test("excludes another user's unlisted/hidden videos but includes the caller's own", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "list-owner-key");
      const stranger = await seedUserWithRoleAndKey("viewer", "list-stranger-key");

      const ownUnlisted = await seedUpload({
        originalFilename: "own-unlisted.mp4",
        userId: owner.id,
      });
      await seedMetadata(ownUnlisted.id, {
        title: "My unlisted",
        visibility: "unlisted",
      });
      const ownHidden = await seedUpload({
        originalFilename: "own-hidden.mp4",
        userId: owner.id,
      });
      await seedMetadata(ownHidden.id, {
        title: "My hidden",
        visibility: "hidden",
      });
      const othersUnlisted = await seedUpload({
        originalFilename: "others-unlisted.mp4",
        userId: stranger.id,
      });
      await seedMetadata(othersUnlisted.id, {
        title: "Someone else's unlisted",
        visibility: "unlisted",
      });

      const anonRes = await client.get("/api/v1/videos");
      expect(anonRes.status).toBe(200);
      const anonTitles = anonRes.body.items.map((item) => item.title);
      expect(anonTitles).not.toContain("My unlisted");
      expect(anonTitles).not.toContain("My hidden");
      expect(anonTitles).not.toContain("Someone else's unlisted");

      const ownerRes = await client
        .get("/api/v1/videos")
        .set("Authorization", "Bearer list-owner-key");
      expect(ownerRes.status).toBe(200);
      const ownerTitles = ownerRes.body.items.map((item) => item.title);
      expect(ownerTitles).toContain("My unlisted");
      expect(ownerTitles).toContain("My hidden");
      expect(ownerTitles).not.toContain("Someone else's unlisted");
    });

    test("includes the caller's own private videos and private videos they have a grant for", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "list-private-owner-key");
      const grantee = await seedUserWithRoleAndKey("viewer", "list-private-grantee-key");
      const stranger = await seedUserWithRoleAndKey("viewer", "list-private-stranger-key");

      const ownPrivate = await seedUpload({
        originalFilename: "own-private.mp4",
        userId: owner.id,
      });
      await seedMetadata(ownPrivate.id, {
        title: "My private",
        visibility: "private",
      });

      const sharedPrivate = await seedUpload({
        originalFilename: "shared-private.mp4",
        userId: owner.id,
      });
      await seedMetadata(sharedPrivate.id, {
        title: "Shared with grantee",
        visibility: "private",
      });
      await seedVideoAccess(sharedPrivate.id, grantee.id);

      const ownerRes = await client
        .get("/api/v1/videos")
        .set("Authorization", "Bearer list-private-owner-key");
      const ownerTitles = ownerRes.body.items.map((item) => item.title);
      expect(ownerTitles).toContain("My private");
      expect(ownerTitles).toContain("Shared with grantee");

      const granteeRes = await client
        .get("/api/v1/videos")
        .set("Authorization", "Bearer list-private-grantee-key");
      const granteeTitles = granteeRes.body.items.map((item) => item.title);
      expect(granteeTitles).toContain("Shared with grantee");
      expect(granteeTitles).not.toContain("My private");

      const strangerRes = await client
        .get("/api/v1/videos")
        .set("Authorization", "Bearer list-private-stranger-key");
      const strangerTitles = strangerRes.body.items.map((item) => item.title);
      expect(strangerTitles).not.toContain("My private");
      expect(strangerTitles).not.toContain("Shared with grantee");
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
    test("sets visibility to unlisted for moderators", async () => {
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
      expect(res.body.visibility).toBe("unlisted");
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

    test("notifies the video owner, but not on an unowned video or a self-delist", async () => {
      const mod = await seedUserWithRoleAndKey("moderator", "mod-delist-notify-key");
      const owner = await seedUserWithRoleAndKey("viewer", "delist-owner-key");

      // Unowned video: no owner to notify.
      const unowned = await seedUpload();
      await seedMetadata(unowned.id, { title: "Unowned", visibility: "public" });
      await client
        .post(`/api/v1/videos/${unowned.id}/delist`)
        .set("Authorization", "Bearer mod-delist-notify-key");
      expect(await queryRows("SELECT * FROM NOTIFICATIONS", {})).toHaveLength(0);

      // Moderator delisting their own video: no self-notification.
      const own = await seedUpload({ userId: mod.id });
      await seedMetadata(own.id, { title: "Own video", visibility: "public" });
      await client
        .post(`/api/v1/videos/${own.id}/delist`)
        .set("Authorization", "Bearer mod-delist-notify-key");
      expect(
        await queryRows("SELECT * FROM NOTIFICATIONS WHERE user_id = :userId", { userId: mod.id }),
      ).toHaveLength(0);

      // Moderator delisting someone else's video: owner is notified.
      const owned = await seedUpload({ userId: owner.id });
      await seedMetadata(owned.id, { title: "Someone else's video", visibility: "public" });
      await client
        .post(`/api/v1/videos/${owned.id}/delist`)
        .set("Authorization", "Bearer mod-delist-notify-key");

      const rows = await queryRows("SELECT * FROM NOTIFICATIONS WHERE user_id = :userId", {
        userId: owner.id,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe("Video Moderated");
      expect(rows[0].target).toBe(owned.videoId);
    });

    test("response includes tags and complete renditions, same as getVideo", async () => {
      await seedUserWithRoleAndKey("moderator", "mod-delist-shape-key");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { title: "To delist", visibility: "public" });
      await seedContentTag(upload.id, { tag: "keeper" });
      const complete = await seedFileVersion(upload.id, {
        status: "complete",
        resolution: "480p",
        videoWidth: 854,
        videoHeight: 480,
      });

      const res = await client
        .post(`/api/v1/videos/${upload.id}/delist`)
        .set("Authorization", "Bearer mod-delist-shape-key");

      expect(res.status).toBe(200);
      expect(res.body.tags).toEqual(["keeper"]);
      expect(res.body.renditions).toEqual([
        {
          id: complete.id,
          resolution: "480p",
          width: 854,
          height: 480,
          mimeType: "video/mp4",
          fileSizeBytes: 1024,
          streamUrl: `/api/v1/videos/${upload.id}/stream?quality=480p`,
        },
        {
          id: upload.id,
          resolution: "original",
          width: null,
          height: null,
          mimeType: "video/mp4",
          fileSizeBytes: 2048,
          streamUrl: `/api/v1/videos/${upload.id}/stream?quality=original`,
        },
      ]);
    });
  });

  describe("PUT /videos/{id}/featured (setVideoFeatured)", () => {
    test("admins can feature and unfeature a video", async () => {
      await seedUserWithRoleAndKey("admin", "admin-featured-key");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });

      const featureRes = await client
        .put(`/api/v1/videos/${upload.id}/featured`)
        .set("Authorization", "Bearer admin-featured-key")
        .send({ featured: true });
      expect(featureRes.status).toBe(200);
      expect(featureRes.body).toEqual({ featured: true });

      let rows = await queryRows(
        "SELECT * FROM FEATURED_VIDEOS WHERE original_upload_id = :id",
        { id: upload.id },
      );
      expect(rows).toHaveLength(1);

      // Featuring an already-featured video doesn't duplicate the row.
      await client
        .put(`/api/v1/videos/${upload.id}/featured`)
        .set("Authorization", "Bearer admin-featured-key")
        .send({ featured: true });
      rows = await queryRows(
        "SELECT * FROM FEATURED_VIDEOS WHERE original_upload_id = :id",
        { id: upload.id },
      );
      expect(rows).toHaveLength(1);

      const unfeatureRes = await client
        .put(`/api/v1/videos/${upload.id}/featured`)
        .set("Authorization", "Bearer admin-featured-key")
        .send({ featured: false });
      expect(unfeatureRes.status).toBe(200);
      expect(unfeatureRes.body).toEqual({ featured: false });

      rows = await queryRows(
        "SELECT * FROM FEATURED_VIDEOS WHERE original_upload_id = :id",
        { id: upload.id },
      );
      expect(rows).toHaveLength(0);
    });

    test("forbids moderators and viewers from setting featured status", async () => {
      await seedUserWithRoleAndKey("moderator", "mod-featured-key");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });

      const res = await client
        .put(`/api/v1/videos/${upload.id}/featured`)
        .set("Authorization", "Bearer mod-featured-key")
        .send({ featured: true });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    test("rejects a non-boolean featured value", async () => {
      await seedUserWithRoleAndKey("admin", "admin-featured-bad-body-key");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });

      const res = await client
        .put(`/api/v1/videos/${upload.id}/featured`)
        .set("Authorization", "Bearer admin-featured-bad-body-key")
        .send({ featured: "yes" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_body");
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
        { userId: friend.id, username: "friend_user", displayName: null },
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

    test("rejects setting access on a non-private video", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "owner-nonprivate-access");
      const friend = await seedUser({ username: "friend_nonprivate" });
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id, { visibility: "public" });

      const res = await client
        .put(`/api/v1/videos/${upload.id}/access`)
        .set("Authorization", "Bearer owner-nonprivate-access")
        .send({ usernames: [friend.username] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_state");
    });

    test("wipes existing grants when the video transitions to hidden", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "owner-wipe-access");
      const friend = await seedUser({ username: "friend_wipe" });
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id, { visibility: "private" });
      await seedVideoAccess(upload.id, friend.id);

      const patchRes = await client
        .patch(`/api/v1/videos/${upload.id}`)
        .set("Authorization", "Bearer owner-wipe-access")
        .send({ visibility: "hidden" });
      expect(patchRes.status).toBe(200);

      const getRes = await client
        .get(`/api/v1/videos/${upload.id}/access`)
        .set("Authorization", "Bearer owner-wipe-access");
      expect(getRes.status).toBe(200);
      expect(getRes.body.items).toEqual([]);
    });

    test("preserves existing grants when the video transitions to public or back to private", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "owner-preserve-access");
      const friend = await seedUser({ username: "friend_preserve" });
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id, { visibility: "private" });
      await seedVideoAccess(upload.id, friend.id);

      const toPublic = await client
        .patch(`/api/v1/videos/${upload.id}`)
        .set("Authorization", "Bearer owner-preserve-access")
        .send({ visibility: "public" });
      expect(toPublic.status).toBe(200);

      const backToPrivate = await client
        .patch(`/api/v1/videos/${upload.id}`)
        .set("Authorization", "Bearer owner-preserve-access")
        .send({ visibility: "private" });
      expect(backToPrivate.status).toBe(200);

      const getRes = await client
        .get(`/api/v1/videos/${upload.id}/access`)
        .set("Authorization", "Bearer owner-preserve-access");
      expect(getRes.status).toBe(200);
      expect(getRes.body.items).toHaveLength(1);
      expect(getRes.body.items[0].username).toBe("friend_preserve");
    });
  });

  describe("subscription notifications", () => {
    test("notifies subscribers when a video transitions from private to public", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "sub-notify-owner-key", {
        displayName: "Video Owner",
      });
      const subscriber = await seedUserWithRoleAndKey("viewer", "sub-notify-subscriber-key");
      await seedSubscription(subscriber.id, owner.id);
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id, { title: "New Video", visibility: "private" });

      const subscriberNotifications = () =>
        queryRows("SELECT * FROM NOTIFICATIONS WHERE user_id = :userId", {
          userId: subscriber.id,
        });

      const patchRes = await client
        .patch(`/api/v1/videos/${upload.id}`)
        .set("Authorization", "Bearer sub-notify-owner-key")
        .send({ visibility: "public" });
      expect(patchRes.status).toBe(200);

      let rows = await subscriberNotifications();
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe("Subscription");
      expect(rows[0].message).toBe("Video Owner has posted a new video");
      expect(rows[0].target).toBe(upload.videoId);

      // Re-patching an already-public video does not create a duplicate.
      const secondPatch = await client
        .patch(`/api/v1/videos/${upload.id}`)
        .set("Authorization", "Bearer sub-notify-owner-key")
        .send({ title: "New Video (edited)" });
      expect(secondPatch.status).toBe(200);

      rows = await subscriberNotifications();
      expect(rows).toHaveLength(1);
    });

    test("notifies every subscriber, and does not error when there are none", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "sub-notify-owner-multi-key");
      const subscriberA = await seedUserWithRoleAndKey("viewer", "sub-notify-a-key");
      const subscriberB = await seedUserWithRoleAndKey("viewer", "sub-notify-b-key");
      await seedSubscription(subscriberA.id, owner.id);
      await seedSubscription(subscriberB.id, owner.id);
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id, { visibility: "private" });

      const patchRes = await client
        .patch(`/api/v1/videos/${upload.id}`)
        .set("Authorization", "Bearer sub-notify-owner-multi-key")
        .send({ visibility: "public" });
      expect(patchRes.status).toBe(200);

      const notificationsFor = (userId) =>
        queryRows("SELECT * FROM NOTIFICATIONS WHERE user_id = :userId", { userId });
      expect(await notificationsFor(subscriberA.id)).toHaveLength(1);
      expect(await notificationsFor(subscriberB.id)).toHaveLength(1);
    });

    test("does not error when publishing a video with no subscribers", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "sub-notify-owner-none-key");
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id, { visibility: "private" });

      const patchRes = await client
        .patch(`/api/v1/videos/${upload.id}`)
        .set("Authorization", "Bearer sub-notify-owner-none-key")
        .send({ visibility: "public" });
      expect(patchRes.status).toBe(200);
    });
  });

  describe("views and likes", () => {
    test("increments viewCount for public videos and does not record history for anonymous viewers", async () => {
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

      const history = await queryRows(
        "SELECT * FROM USER_VIEW_HISTORY WHERE original_upload_id = :id",
        { id: upload.id },
      );
      expect(history).toHaveLength(0);
    });

    test("records USER_VIEW_HISTORY for authenticated viewers", async () => {
      const viewer = await seedUserWithRoleAndKey("viewer", "view-key-1");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public", viewCount: 0 });

      const res = await client
        .post(`/api/v1/videos/${upload.id}/view`)
        .set("Authorization", "Bearer view-key-1");

      expect(res.status).toBe(200);
      expect(res.body.viewCount).toBe(1);

      const history = await queryRows(
        "SELECT * FROM USER_VIEW_HISTORY WHERE original_upload_id = :id AND user_id = :userId",
        { id: upload.id, userId: viewer.id },
      );
      expect(history).toHaveLength(1);
      const firstUpdatedAt = history[0].updated_at;

      // A second view from the same user upserts the existing row (unique per user/video).
      await client
        .post(`/api/v1/videos/${upload.id}/view`)
        .set("Authorization", "Bearer view-key-1");

      const historyAfter = await queryRows(
        "SELECT * FROM USER_VIEW_HISTORY WHERE original_upload_id = :id AND user_id = :userId",
        { id: upload.id, userId: viewer.id },
      );
      expect(historyAfter).toHaveLength(1);
      expect(historyAfter[0].id).toBe(history[0].id);
      expect(historyAfter[0].created_at).toBe(history[0].created_at);
      expect(new Date(historyAfter[0].updated_at).getTime()).toBeGreaterThanOrEqual(
        new Date(firstUpdatedAt).getTime(),
      );
    });

    test("likes and dislikes require auth, persist VIDEO_LIKES, and toggle off on repeat", async () => {
      const viewer = await seedUserWithRoleAndKey("viewer", "like-key-1");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });

      const likeRow = () =>
        queryRows(
          "SELECT * FROM VIDEO_LIKES WHERE original_upload_id = :id AND user_id = :userId",
          { id: upload.id, userId: viewer.id },
        );

      const likeRes = await client
        .post(`/api/v1/videos/${upload.id}/like`)
        .set("Authorization", "Bearer like-key-1");
      expect(likeRes.status).toBe(200);
      expect(likeRes.body).toEqual({ liked: true, disliked: false });

      let rows = await likeRow();
      expect(rows).toHaveLength(1);
      expect(rows[0].like_value).toBe(1);

      // Switching to dislike replaces the row rather than adding a second one.
      const dislikeRes = await client
        .post(`/api/v1/videos/${upload.id}/dislike`)
        .set("Authorization", "Bearer like-key-1");
      expect(dislikeRes.status).toBe(200);
      expect(dislikeRes.body).toEqual({ liked: false, disliked: true });

      rows = await likeRow();
      expect(rows).toHaveLength(1);
      expect(rows[0].like_value).toBe(-1);

      // Disliking again while already disliked toggles the reaction off.
      const toggleOffRes = await client
        .post(`/api/v1/videos/${upload.id}/dislike`)
        .set("Authorization", "Bearer like-key-1");
      expect(toggleOffRes.status).toBe(200);
      expect(toggleOffRes.body).toEqual({ liked: false, disliked: false });

      rows = await likeRow();
      expect(rows).toHaveLength(0);
    });

    test("liking a video creates a 'My Likes' playlist on first like, unliking removes the item, and switching to a dislike removes it too", async () => {
      const viewer = await seedUserWithRoleAndKey("viewer", "like-playlist-key-1");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });

      const likesPlaylistRows = () =>
        queryRows(
          "SELECT * FROM USER_PLAYLISTS WHERE user_id = :userId AND kind = 'likes'",
          { userId: viewer.id },
        );
      const likesPlaylistItemRows = async () => {
        const [playlist] = await likesPlaylistRows();
        return queryRows(
          "SELECT * FROM PLAYLIST_ITEMS WHERE playlist_id = :playlistId AND original_upload_id = :uploadId",
          { playlistId: playlist.id, uploadId: upload.id },
        );
      };

      expect(await likesPlaylistRows()).toHaveLength(0);

      await client
        .post(`/api/v1/videos/${upload.id}/like`)
        .set("Authorization", "Bearer like-playlist-key-1");

      const playlists = await likesPlaylistRows();
      expect(playlists).toHaveLength(1);
      expect(playlists[0].title).toBe("My Likes");
      expect(await likesPlaylistItemRows()).toHaveLength(1);

      // Unliking (toggle off) removes the video from the playlist, but the
      // playlist itself is not deleted.
      await client
        .post(`/api/v1/videos/${upload.id}/like`)
        .set("Authorization", "Bearer like-playlist-key-1");
      expect(await likesPlaylistItemRows()).toHaveLength(0);
      expect(await likesPlaylistRows()).toHaveLength(1);

      // Liking again re-adds it, then disliking (switching reactions) removes it.
      await client
        .post(`/api/v1/videos/${upload.id}/like`)
        .set("Authorization", "Bearer like-playlist-key-1");
      expect(await likesPlaylistItemRows()).toHaveLength(1);

      await client
        .post(`/api/v1/videos/${upload.id}/dislike`)
        .set("Authorization", "Bearer like-playlist-key-1");
      expect(await likesPlaylistItemRows()).toHaveLength(0);
    });

    test("disliking a video that was never liked does not create a 'My Likes' playlist", async () => {
      const viewer = await seedUserWithRoleAndKey("viewer", "like-playlist-key-2");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });

      await client
        .post(`/api/v1/videos/${upload.id}/dislike`)
        .set("Authorization", "Bearer like-playlist-key-2");

      const playlists = await queryRows(
        "SELECT * FROM USER_PLAYLISTS WHERE user_id = :userId AND kind = 'likes'",
        { userId: viewer.id },
      );
      expect(playlists).toHaveLength(0);
    });

    test("creates a NOTIFICATIONS row for the owner on like, but not on self-like or unlike", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "like-notify-owner-key");
      const liker = await seedUserWithRoleAndKey("viewer", "like-notify-liker-key");
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id, { title: "Notify Me", visibility: "public" });

      // "like" is opt-in (off by default) - explicitly enable in-app delivery
      // for the owner so this test exercises the "opted in" path.
      const likeTypeId = (await NotificationType.findOne({ where: { name: "like" } })).id;
      await seedUserNotificationSetting(owner.id, { notificationTypeId: likeTypeId, enabled: true });

      const ownerNotifications = () =>
        queryRows("SELECT * FROM NOTIFICATIONS WHERE user_id = :userId", { userId: owner.id });

      // Liking your own video does not notify yourself.
      await client
        .post(`/api/v1/videos/${upload.id}/like`)
        .set("Authorization", "Bearer like-notify-owner-key");
      expect(await ownerNotifications()).toHaveLength(0);

      await client
        .post(`/api/v1/videos/${upload.id}/dislike`)
        .set("Authorization", "Bearer like-notify-owner-key");
      expect(await ownerNotifications()).toHaveLength(0);

      const likeRes = await client
        .post(`/api/v1/videos/${upload.id}/like`)
        .set("Authorization", "Bearer like-notify-liker-key");
      expect(likeRes.status).toBe(200);

      let rows = await ownerNotifications();
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe("Video received a Like");
      expect(rows[0].target).toBe(upload.videoId);

      // Toggling the like off does not create a second notification.
      await client
        .post(`/api/v1/videos/${upload.id}/like`)
        .set("Authorization", "Bearer like-notify-liker-key");
      rows = await ownerNotifications();
      expect(rows).toHaveLength(1);
    });

    test("getVideo includes viewerReaction only for authenticated callers", async () => {
      await seedUserWithRoleAndKey("viewer", "like-key-2");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });

      const anonRes = await client.get(`/api/v1/videos/${upload.id}`);
      expect(anonRes.status).toBe(200);
      expect(anonRes.body.viewerReaction).toBeUndefined();

      const beforeRes = await client
        .get(`/api/v1/videos/${upload.id}`)
        .set("Authorization", "Bearer like-key-2");
      expect(beforeRes.status).toBe(200);
      expect(beforeRes.body.viewerReaction).toBeNull();

      await client
        .post(`/api/v1/videos/${upload.id}/like`)
        .set("Authorization", "Bearer like-key-2");

      const afterRes = await client
        .get(`/api/v1/videos/${upload.id}`)
        .set("Authorization", "Bearer like-key-2");
      expect(afterRes.status).toBe(200);
      expect(afterRes.body.viewerReaction).toBe("like");
    });

    test("likeCount and dislikeCount reflect aggregate VIDEO_LIKES across getVideo and listVideos", async () => {
      await seedUserWithRoleAndKey("viewer", "count-key-1");
      await seedUserWithRoleAndKey("viewer", "count-key-2");
      await seedUserWithRoleAndKey("viewer", "count-key-3");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { title: "Counted", visibility: "public" });

      const zeroRes = await client.get(`/api/v1/videos/${upload.id}`);
      expect(zeroRes.body.likeCount).toBe(0);
      expect(zeroRes.body.dislikeCount).toBe(0);

      await client
        .post(`/api/v1/videos/${upload.id}/like`)
        .set("Authorization", "Bearer count-key-1");
      await client
        .post(`/api/v1/videos/${upload.id}/like`)
        .set("Authorization", "Bearer count-key-2");
      await client
        .post(`/api/v1/videos/${upload.id}/dislike`)
        .set("Authorization", "Bearer count-key-3");

      const getRes = await client.get(`/api/v1/videos/${upload.id}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.likeCount).toBe(2);
      expect(getRes.body.dislikeCount).toBe(1);

      const listRes = await client.get("/api/v1/videos");
      expect(listRes.status).toBe(200);
      const listed = listRes.body.items.find((item) => item.id === upload.id);
      expect(listed.likeCount).toBe(2);
      expect(listed.dislikeCount).toBe(1);
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

    test("excludes videos already in the caller's watch history", async () => {
      const viewer = await seedUserWithRoleAndKey("viewer", "feed-key-watched");
      const channel = await seedUser({ username: "channel_watched" });
      await seedSubscription(viewer.id, channel.id);

      const watched = await seedUpload({ userId: channel.id });
      await seedMetadata(watched.id, { title: "Already watched", visibility: "public" });
      await seedUserViewHistory(watched.id, { userId: viewer.id });

      const unwatched = await seedUpload({ userId: channel.id });
      await seedMetadata(unwatched.id, { title: "Not watched yet", visibility: "public" });

      const res = await client
        .get("/api/v1/feed/subscriptions")
        .set("Authorization", "Bearer feed-key-watched");

      expect(res.status).toBe(200);
      const titles = res.body.items.map((item) => item.title);
      expect(titles).toContain("Not watched yet");
      expect(titles).not.toContain("Already watched");
    });
  });
});
