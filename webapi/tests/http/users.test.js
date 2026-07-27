import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { resolveSitedataPath } from "../../lib/sitedata-meta.js";
import { createTestClient } from "../helpers/app.js";
import { resetTables, seedUser, setupSchema } from "../helpers/db.js";

const avatarsDir = resolveSitedataPath("avatars");

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
