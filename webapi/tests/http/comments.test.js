import {
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "@jest/globals";
import { Role } from "../../lib/models/index.js";
import { createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedComment,
  seedMetadata,
  seedUpload,
  seedUser,
  seedUserApiKey,
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
 * HTTP contract tests for the video comments resource.
 */
describe("Video comments endpoints", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  describe("POST /videos/{id}/comments (createComment)", () => {
    test("rejects unauthenticated requests", async () => {
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });

      const res = await client
        .post(`/api/v1/videos/${upload.id}/comments`)
        .set("Authorization", "Bearer jt_not_a_real_key")
        .send({ body: "hello" });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("unauthorized");
    });

    test("returns 404 for an inaccessible (private, no grant) video", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "comment-owner-key");
      await seedUserWithRoleAndKey("viewer", "comment-outsider-key");
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id, { visibility: "private" });

      const res = await client
        .post(`/api/v1/videos/${upload.id}/comments`)
        .set("Authorization", "Bearer comment-outsider-key")
        .send({ body: "hello" });

      expect(res.status).toBe(404);
    });

    test("creates a top-level comment with the expected shape", async () => {
      const user = await seedUserWithRoleAndKey("viewer", "comment-create-key");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });

      const res = await client
        .post(`/api/v1/videos/${upload.id}/comments`)
        .set("Authorization", "Bearer comment-create-key")
        .send({ body: "Great video!" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        originalUploadId: upload.id,
        parentCommentId: null,
        body: "Great video!",
        distinguishedMod: false,
        distinguishedAdmin: false,
        author: { userId: user.id, username: user.username },
      });
      expect(res.body.id).toEqual(expect.any(Number));
    });

    test("creates a reply via parentCommentId", async () => {
      const user = await seedUserWithRoleAndKey("viewer", "comment-reply-key");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });
      const parent = await seedComment(upload.id, user.id, { body: "parent" });

      const res = await client
        .post(`/api/v1/videos/${upload.id}/comments`)
        .set("Authorization", "Bearer comment-reply-key")
        .send({ body: "a reply", parentCommentId: parent.id });

      expect(res.status).toBe(201);
      expect(res.body.parentCommentId).toBe(parent.id);
    });

    test("rejects a parentCommentId belonging to a different video", async () => {
      const user = await seedUserWithRoleAndKey("viewer", "comment-cross-key");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });
      const otherUpload = await seedUpload();
      await seedMetadata(otherUpload.id, { visibility: "public" });
      const otherParent = await seedComment(otherUpload.id, user.id);

      const res = await client
        .post(`/api/v1/videos/${upload.id}/comments`)
        .set("Authorization", "Bearer comment-cross-key")
        .send({ body: "reply", parentCommentId: otherParent.id });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_parent_comment");
    });

    test("rejects an empty body", async () => {
      await seedUserWithRoleAndKey("viewer", "comment-empty-key");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });

      const res = await client
        .post(`/api/v1/videos/${upload.id}/comments`)
        .set("Authorization", "Bearer comment-empty-key")
        .send({ body: "   " });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_body");
    });

    describe("commentsEnabled: false", () => {
      test("blocks a plain viewer", async () => {
        await seedUserWithRoleAndKey("viewer", "comment-disabled-viewer-key");
        const upload = await seedUpload();
        await seedMetadata(upload.id, { visibility: "public", commentsEnabled: false });

        const res = await client
          .post(`/api/v1/videos/${upload.id}/comments`)
          .set("Authorization", "Bearer comment-disabled-viewer-key")
          .send({ body: "hello" });

        expect(res.status).toBe(403);
        expect(res.body.error).toBe("comments_disabled");
      });

      test("blocks a moderator posting with no distinguished flag", async () => {
        await seedUserWithRoleAndKey("moderator", "comment-disabled-mod-key");
        const upload = await seedUpload();
        await seedMetadata(upload.id, { visibility: "public", commentsEnabled: false });

        const res = await client
          .post(`/api/v1/videos/${upload.id}/comments`)
          .set("Authorization", "Bearer comment-disabled-mod-key")
          .send({ body: "mod note" });

        expect(res.status).toBe(403);
        expect(res.body.error).toBe("comments_disabled");
      });

      test("allows a moderator self-distinguishing with distinguishedMod: true", async () => {
        await seedUserWithRoleAndKey("moderator", "comment-disabled-mod-ok-key");
        const upload = await seedUpload();
        await seedMetadata(upload.id, { visibility: "public", commentsEnabled: false });

        const res = await client
          .post(`/api/v1/videos/${upload.id}/comments`)
          .set("Authorization", "Bearer comment-disabled-mod-ok-key")
          .send({ body: "mod note", distinguishedMod: true });

        expect(res.status).toBe(201);
        expect(res.body.distinguishedMod).toBe(true);
      });

      test("rejects a moderator attempting distinguishedAdmin", async () => {
        await seedUserWithRoleAndKey("moderator", "comment-mod-forbidden-key");
        const upload = await seedUpload();
        await seedMetadata(upload.id, { visibility: "public", commentsEnabled: false });

        const res = await client
          .post(`/api/v1/videos/${upload.id}/comments`)
          .set("Authorization", "Bearer comment-mod-forbidden-key")
          .send({ body: "mod note", distinguishedAdmin: true });

        expect(res.status).toBe(403);
        expect(res.body.error).toBe("forbidden");
      });

      test("allows an admin self-distinguishing with distinguishedAdmin: true", async () => {
        await seedUserWithRoleAndKey("admin", "comment-disabled-admin-key");
        const upload = await seedUpload();
        await seedMetadata(upload.id, { visibility: "public", commentsEnabled: false });

        const res = await client
          .post(`/api/v1/videos/${upload.id}/comments`)
          .set("Authorization", "Bearer comment-disabled-admin-key")
          .send({ body: "admin note", distinguishedAdmin: true });

        expect(res.status).toBe(201);
        expect(res.body.distinguishedAdmin).toBe(true);
      });
    });
  });

  describe("GET /videos/{id}/comments (listComments)", () => {
    test("works unauthenticated for a public video and includes replies flat", async () => {
      const author = await seedUserWithRoleAndKey("viewer", "comment-list-author-key");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });
      const parent = await seedComment(upload.id, author.id, { body: "top level" });
      const reply = await seedComment(upload.id, author.id, {
        body: "a reply",
        parentCommentId: parent.id,
      });

      const res = await client.get(`/api/v1/videos/${upload.id}/comments`);

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      const replyItem = res.body.items.find((item) => item.id === reply.id);
      expect(replyItem.parentCommentId).toBe(parent.id);
    });

    test("returns 404 for an inaccessible video", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "comment-list-owner-key");
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id, { visibility: "private" });

      const res = await client.get(`/api/v1/videos/${upload.id}/comments`);

      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /videos/{id}/comments/{commentId} (updateComment)", () => {
    test("lets the author edit their own comment body", async () => {
      const author = await seedUserWithRoleAndKey("viewer", "comment-edit-author-key");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });
      const comment = await seedComment(upload.id, author.id, { body: "before" });

      const res = await client
        .patch(`/api/v1/videos/${upload.id}/comments/${comment.id}`)
        .set("Authorization", "Bearer comment-edit-author-key")
        .send({ body: "after" });

      expect(res.status).toBe(200);
      expect(res.body.body).toBe("after");
    });

    test("forbids a non-author from editing the body", async () => {
      const author = await seedUserWithRoleAndKey("viewer", "comment-edit-owner-key");
      await seedUserWithRoleAndKey("viewer", "comment-edit-outsider-key");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });
      const comment = await seedComment(upload.id, author.id, { body: "before" });

      const res = await client
        .patch(`/api/v1/videos/${upload.id}/comments/${comment.id}`)
        .set("Authorization", "Bearer comment-edit-outsider-key")
        .send({ body: "hijacked" });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    test("lets a moderator set distinguishedMod on someone else's comment", async () => {
      const author = await seedUserWithRoleAndKey("viewer", "comment-mod-flag-author-key");
      await seedUserWithRoleAndKey("moderator", "comment-mod-flag-mod-key");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });
      const comment = await seedComment(upload.id, author.id);

      const res = await client
        .patch(`/api/v1/videos/${upload.id}/comments/${comment.id}`)
        .set("Authorization", "Bearer comment-mod-flag-mod-key")
        .send({ distinguishedMod: true });

      expect(res.status).toBe(200);
      expect(res.body.distinguishedMod).toBe(true);
    });

    test("forbids a moderator from setting distinguishedAdmin", async () => {
      const author = await seedUserWithRoleAndKey("viewer", "comment-mod-admin-author-key");
      await seedUserWithRoleAndKey("moderator", "comment-mod-admin-mod-key");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });
      const comment = await seedComment(upload.id, author.id);

      const res = await client
        .patch(`/api/v1/videos/${upload.id}/comments/${comment.id}`)
        .set("Authorization", "Bearer comment-mod-admin-mod-key")
        .send({ distinguishedAdmin: true });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    test("lets an admin set both distinguished flags", async () => {
      const author = await seedUserWithRoleAndKey("viewer", "comment-admin-flags-author-key");
      await seedUserWithRoleAndKey("admin", "comment-admin-flags-admin-key");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });
      const comment = await seedComment(upload.id, author.id);

      const res = await client
        .patch(`/api/v1/videos/${upload.id}/comments/${comment.id}`)
        .set("Authorization", "Bearer comment-admin-flags-admin-key")
        .send({ distinguishedMod: true, distinguishedAdmin: true });

      expect(res.status).toBe(200);
      expect(res.body.distinguishedMod).toBe(true);
      expect(res.body.distinguishedAdmin).toBe(true);
    });

    test("rejects an empty patch", async () => {
      const author = await seedUserWithRoleAndKey("viewer", "comment-empty-patch-key");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });
      const comment = await seedComment(upload.id, author.id);

      const res = await client
        .patch(`/api/v1/videos/${upload.id}/comments/${comment.id}`)
        .set("Authorization", "Bearer comment-empty-patch-key")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_body");
    });
  });

  describe("DELETE /videos/{id}/comments/{commentId} (deleteComment)", () => {
    test("lets the author delete their own comment", async () => {
      const author = await seedUserWithRoleAndKey("viewer", "comment-del-author-key");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });
      const comment = await seedComment(upload.id, author.id);

      const res = await client
        .delete(`/api/v1/videos/${upload.id}/comments/${comment.id}`)
        .set("Authorization", "Bearer comment-del-author-key");

      expect(res.status).toBe(204);
    });

    test("forbids an unrelated viewer from deleting", async () => {
      const author = await seedUserWithRoleAndKey("viewer", "comment-del-owner-key");
      await seedUserWithRoleAndKey("viewer", "comment-del-outsider-key");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });
      const comment = await seedComment(upload.id, author.id);

      const res = await client
        .delete(`/api/v1/videos/${upload.id}/comments/${comment.id}`)
        .set("Authorization", "Bearer comment-del-outsider-key");

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    test("lets a moderator delete a plain comment", async () => {
      const author = await seedUserWithRoleAndKey("viewer", "comment-del-mod-author-key");
      await seedUserWithRoleAndKey("moderator", "comment-del-mod-key");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });
      const comment = await seedComment(upload.id, author.id);

      const res = await client
        .delete(`/api/v1/videos/${upload.id}/comments/${comment.id}`)
        .set("Authorization", "Bearer comment-del-mod-key");

      expect(res.status).toBe(204);
    });

    test("forbids a moderator from deleting a distinguishedAdmin comment", async () => {
      const author = await seedUserWithRoleAndKey("viewer", "comment-del-mod2-author-key");
      await seedUserWithRoleAndKey("moderator", "comment-del-mod2-key");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });
      const comment = await seedComment(upload.id, author.id, { distinguishedAdmin: true });

      const res = await client
        .delete(`/api/v1/videos/${upload.id}/comments/${comment.id}`)
        .set("Authorization", "Bearer comment-del-mod2-key");

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    test("lets an admin delete a distinguishedAdmin comment", async () => {
      const author = await seedUserWithRoleAndKey("viewer", "comment-del-admin-author-key");
      await seedUserWithRoleAndKey("admin", "comment-del-admin-key");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });
      const comment = await seedComment(upload.id, author.id, { distinguishedAdmin: true });

      const res = await client
        .delete(`/api/v1/videos/${upload.id}/comments/${comment.id}`)
        .set("Authorization", "Bearer comment-del-admin-key");

      expect(res.status).toBe(204);
    });

    test("cascades to delete replies when the parent comment is deleted", async () => {
      const author = await seedUserWithRoleAndKey("viewer", "comment-del-cascade-key");
      const upload = await seedUpload();
      await seedMetadata(upload.id, { visibility: "public" });
      const parent = await seedComment(upload.id, author.id, { body: "parent" });
      await seedComment(upload.id, author.id, { body: "child", parentCommentId: parent.id });

      const deleteRes = await client
        .delete(`/api/v1/videos/${upload.id}/comments/${parent.id}`)
        .set("Authorization", "Bearer comment-del-cascade-key");
      expect(deleteRes.status).toBe(204);

      const listRes = await client.get(`/api/v1/videos/${upload.id}/comments`);
      expect(listRes.body.items).toHaveLength(0);
    });
  });
});
