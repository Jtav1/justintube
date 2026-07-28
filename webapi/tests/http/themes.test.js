import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { Role, Theme, User } from "../../lib/models/index.js";
import { resolveSitedataPath } from "../../lib/sitedata-meta.js";
import { createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedTheme,
  seedUser,
  seedUserApiKey,
  setupSchema,
} from "../helpers/db.js";

const themesDir = resolveSitedataPath("themes");

/**
 * Default color fields satisfying createTheme's required color1-color5.
 *
 * @type {Record<string, string>}
 */
const DEFAULT_COLORS = {
  color1: "FFFFFF",
  color2: "000000",
  color3: "FF0000",
  color4: "00FF00",
  color5: "0000FF",
};

/**
 * Seeds a user with a role and a Bearer API key (skips CSRF entirely, per
 * `csrfProtection`'s Bearer-token bypass).
 *
 * @param {string} roleName Seeded role name (e.g. "viewer", "admin").
 * @param {string} rawKey Plaintext API key used in the Authorization header.
 * @param {object} [overrides] Extra USERS column overrides.
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
 * Applies text fields and file attachments to a supertest request, switching
 * it to multipart/form-data (matching the themes router's multer.fields).
 *
 * @param {import('supertest').Test} req In-flight supertest request.
 * @param {Record<string, string>} [fields] Form field name/value pairs.
 * @param {Record<string, {buffer: Buffer, filename: string}>} [files]
 *   Multer field name -> file to attach.
 * @returns {import('supertest').Test} The same request, for chaining.
 */
function withMultipart(req, fields = {}, files = {}) {
  let r = req;
  for (const [key, value] of Object.entries(fields)) {
    r = r.field(key, String(value));
  }
  for (const [field, { buffer, filename }] of Object.entries(files)) {
    r = r.attach(field, buffer, filename);
  }
  return r;
}

/**
 * Checks whether a file exists on disk.
 *
 * @param {string} path Absolute path to check.
 * @returns {Promise<boolean>} True when the file exists.
 */
async function fileExists(path) {
  return access(path)
    .then(() => true)
    .catch(() => false);
}

describe("themes routes", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  describe("GET /api/v1/themes (listThemes)", () => {
    test("anonymous callers see only public themes and no selectedThemeId", async () => {
      await seedTheme({ name: "Public A", themeOwner: "public" });
      const owner = await seedUserWithRoleAndKey("viewer", "list-owner-key-1");
      await seedTheme({ name: "Private B", themeOwner: String(owner.id) });

      const res = await client.get("/api/v1/themes");

      expect(res.status).toBe(200);
      expect(res.body.items.map((t) => t.name)).toEqual(["Light", "Dark", "Public A"]);
      expect(res.body.selectedThemeId).toBeUndefined();
    });

    test("authenticated non-admin sees public + own themes with selectedThemeId", async () => {
      const user = await seedUserWithRoleAndKey("viewer", "list-user-key-1");
      const other = await seedUserWithRoleAndKey("viewer", "list-other-key-1");
      await seedTheme({ name: "Public", themeOwner: "public" });
      await seedTheme({ name: "Own", themeOwner: String(user.id) });
      await seedTheme({ name: "Others", themeOwner: String(other.id) });

      const res = await client
        .get("/api/v1/themes")
        .set("Authorization", "Bearer list-user-key-1");

      expect(res.status).toBe(200);
      expect(res.body.items.map((t) => t.name).sort()).toEqual(["Own", "Public"]);
      expect(res.body.selectedThemeId).toBeNull();
    });

    test("selectedThemeId reflects the user's themeId when set", async () => {
      const user = await seedUserWithRoleAndKey("viewer", "list-selected-key-1");
      const theme = await seedTheme({ themeOwner: "public" });
      await User.update({ themeId: theme.id }, { where: { id: user.id } });

      const res = await client
        .get("/api/v1/themes")
        .set("Authorization", "Bearer list-selected-key-1");

      expect(res.status).toBe(200);
      expect(res.body.selectedThemeId).toBe(theme.id);
    });

    test("selectedThemeId falls back to the isDefault theme when unset", async () => {
      const user = await seedUserWithRoleAndKey("viewer", "list-default-key-1");
      await seedTheme({ name: "Not default", themeOwner: "public", isDefault: false });
      const defaultTheme = await seedTheme({
        name: "Default",
        themeOwner: "public",
        isDefault: true,
      });

      const res = await client
        .get("/api/v1/themes")
        .set("Authorization", "Bearer list-default-key-1");

      expect(res.status).toBe(200);
      expect(res.body.selectedThemeId).toBe(defaultTheme.id);
    });

    test("admin sees every theme regardless of owner", async () => {
      const admin = await seedUserWithRoleAndKey("admin", "list-admin-key-1");
      const other = await seedUserWithRoleAndKey("viewer", "list-admin-other-key-1");
      await seedTheme({ name: "Public", themeOwner: "public" });
      await seedTheme({ name: "Someone else's", themeOwner: String(other.id) });

      const res = await client.get("/api/v1/themes").set("Authorization", "Bearer list-admin-key-1");

      expect(res.status).toBe(200);
      expect(res.body.items.map((t) => t.name).sort()).toEqual(["Public", "Someone else's"]);
    });
  });

  describe("POST /api/v1/themes (createTheme)", () => {
    test("creates a theme owned by the caller, with background images", async () => {
      const user = await seedUserWithRoleAndKey("viewer", "create-key-1");

      const res = await withMultipart(
        client.post("/api/v1/themes").set("Authorization", "Bearer create-key-1"),
        { name: "My Theme", ...DEFAULT_COLORS },
        {
          headerBackground: { buffer: Buffer.from("header"), filename: "header.jpg" },
          sidebarBackground: { buffer: Buffer.from("sidebar"), filename: "sidebar.png" },
        },
      );

      expect(res.status).toBe(201);
      expect(res.body.name).toBe("My Theme");
      expect(res.body.themeOwner).toBe(String(user.id));
      expect(res.body.colors).toEqual(DEFAULT_COLORS);
      expect(res.body.isDefault).toBe(false);
      expect(res.body.images.headerBackgroundUrl).toBe(
        `/api/v1/themes/${res.body.id}/images/header`,
      );
      expect(res.body.images.sidebarBackgroundUrl).toBe(
        `/api/v1/themes/${res.body.id}/images/sidebar`,
      );
      expect(res.body.images.viewBackgroundUrl).toBeNull();
      expect(res.body.images.footerBackgroundUrl).toBeNull();

      const imageRes = await client.get(res.body.images.headerBackgroundUrl);
      expect(imageRes.status).toBe(200);
      expect(imageRes.body.toString()).toBe("header");
    });

    test("missing a required color returns 400 invalid_body", async () => {
      await seedUserWithRoleAndKey("viewer", "create-key-2");
      const { color1: _drop, ...missingColor1 } = DEFAULT_COLORS;

      const res = await withMultipart(
        client.post("/api/v1/themes").set("Authorization", "Bearer create-key-2"),
        { name: "Incomplete", ...missingColor1 },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_body");
    });

    test("a non-admin sending system=true is rejected with 403", async () => {
      await seedUserWithRoleAndKey("viewer", "create-key-3");

      const res = await withMultipart(
        client.post("/api/v1/themes").set("Authorization", "Bearer create-key-3"),
        { name: "Sneaky Public", system: "true", ...DEFAULT_COLORS },
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    test("a non-admin sending isDefault=true is rejected with 403", async () => {
      await seedUserWithRoleAndKey("viewer", "create-key-4");

      const res = await withMultipart(
        client.post("/api/v1/themes").set("Authorization", "Bearer create-key-4"),
        { name: "Sneaky Default", isDefault: "true", ...DEFAULT_COLORS },
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    test("an admin creating a public default theme unsets any prior default", async () => {
      await seedUserWithRoleAndKey("admin", "create-admin-key-1");
      const previousDefault = await seedTheme({
        name: "Old default",
        themeOwner: "public",
        isDefault: true,
      });

      const res = await withMultipart(
        client.post("/api/v1/themes").set("Authorization", "Bearer create-admin-key-1"),
        { name: "New default", system: "true", isDefault: "true", ...DEFAULT_COLORS },
      );

      expect(res.status).toBe(201);
      expect(res.body.themeOwner).toBe("public");
      expect(res.body.isDefault).toBe(true);

      const reloaded = await client.get("/api/v1/themes");
      const oldRow = reloaded.body.items.find((t) => t.id === previousDefault.id);
      expect(oldRow.isDefault).toBe(false);
    });
  });

  describe("PATCH /api/v1/themes/:id (updateTheme)", () => {
    test("the owner can update their own theme", async () => {
      const user = await seedUserWithRoleAndKey("viewer", "update-key-1");
      const theme = await seedTheme({ themeOwner: String(user.id), name: "Before" });

      const res = await withMultipart(
        client.patch(`/api/v1/themes/${theme.id}`).set("Authorization", "Bearer update-key-1"),
        { name: "After" },
      );

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("After");
    });

    test("a non-owner non-admin is rejected with 403", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "update-owner-key-2");
      await seedUserWithRoleAndKey("viewer", "update-intruder-key-2");
      const theme = await seedTheme({ themeOwner: String(owner.id) });

      const res = await withMultipart(
        client.patch(`/api/v1/themes/${theme.id}`).set("Authorization", "Bearer update-intruder-key-2"),
        { name: "Hijacked" },
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    test("an admin can update anyone's theme", async () => {
      await seedUserWithRoleAndKey("admin", "update-admin-key-1");
      const owner = await seedUserWithRoleAndKey("viewer", "update-owner-key-3");
      const theme = await seedTheme({ themeOwner: String(owner.id), name: "Before" });

      const res = await withMultipart(
        client.patch(`/api/v1/themes/${theme.id}`).set("Authorization", "Bearer update-admin-key-1"),
        { name: "Admin edited" },
      );

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Admin edited");
    });

    test("replacing an image deletes the previous file from disk", async () => {
      await seedUserWithRoleAndKey("viewer", "update-key-4");
      const created = await withMultipart(
        client.post("/api/v1/themes").set("Authorization", "Bearer update-key-4"),
        { name: "Has image", ...DEFAULT_COLORS },
        { headerBackground: { buffer: Buffer.from("first"), filename: "first.jpg" } },
      );
      expect(created.status).toBe(201);
      const themeId = created.body.id;

      const theme = await seedThemeLookup(themeId);
      const firstPath = join(themesDir, theme.headerBackgroundFilename);
      expect(await fileExists(firstPath)).toBe(true);

      const updated = await withMultipart(
        client.patch(`/api/v1/themes/${themeId}`).set("Authorization", "Bearer update-key-4"),
        {},
        { headerBackground: { buffer: Buffer.from("second"), filename: "second.png" } },
      );
      expect(updated.status).toBe(200);

      expect(await fileExists(firstPath)).toBe(false);
      const themeAfter = await seedThemeLookup(themeId);
      expect(await fileExists(join(themesDir, themeAfter.headerBackgroundFilename))).toBe(true);
    });

    test("updating a public theme as a non-admin is rejected with 403", async () => {
      await seedUserWithRoleAndKey("viewer", "update-key-5");
      const theme = await seedTheme({ themeOwner: "public", name: "Public theme" });

      const res = await withMultipart(
        client.patch(`/api/v1/themes/${theme.id}`).set("Authorization", "Bearer update-key-5"),
        { name: "Hijacked public" },
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });
  });

  describe("DELETE /api/v1/themes/:id (deleteTheme)", () => {
    test("a non-owner non-admin is rejected with 403", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "delete-owner-key-1");
      await seedUserWithRoleAndKey("viewer", "delete-intruder-key-1");
      const theme = await seedTheme({ themeOwner: String(owner.id) });

      const res = await client
        .delete(`/api/v1/themes/${theme.id}`)
        .set("Authorization", "Bearer delete-intruder-key-1");

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    test("the owner can delete their theme, removing image files and clearing selections", async () => {
      const user = await seedUserWithRoleAndKey("viewer", "delete-key-1");
      const created = await withMultipart(
        client.post("/api/v1/themes").set("Authorization", "Bearer delete-key-1"),
        { name: "To delete", ...DEFAULT_COLORS },
        { headerBackground: { buffer: Buffer.from("bytes"), filename: "h.jpg" } },
      );
      expect(created.status).toBe(201);
      const themeId = created.body.id;

      const theme = await seedThemeLookup(themeId);
      const imagePath = join(themesDir, theme.headerBackgroundFilename);
      expect(await fileExists(imagePath)).toBe(true);

      await client.put("/api/v1/me/theme").set("Authorization", "Bearer delete-key-1").send({
        themeId,
      });

      const del = await client
        .delete(`/api/v1/themes/${themeId}`)
        .set("Authorization", "Bearer delete-key-1");
      expect(del.status).toBe(200);
      expect(del.body).toEqual({ success: true });
      expect(await fileExists(imagePath)).toBe(false);

      const selection = await client
        .get(`/api/v1/users/${user.id}/theme`)
        .set("Authorization", "Bearer delete-key-1");
      expect(selection.body.themeId).toBeNull();
      expect(selection.body.theme).toBeNull();
    });

    test("an admin can delete anyone's theme", async () => {
      await seedUserWithRoleAndKey("admin", "delete-admin-key-1");
      const owner = await seedUserWithRoleAndKey("viewer", "delete-owner-key-2");
      const theme = await seedTheme({ themeOwner: String(owner.id) });

      const res = await client
        .delete(`/api/v1/themes/${theme.id}`)
        .set("Authorization", "Bearer delete-admin-key-1");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
    });
  });

  describe("GET /api/v1/themes/:id/images/:slot (getThemeImage)", () => {
    test("returns 404 for an unknown slot", async () => {
      const theme = await seedTheme();
      const res = await client.get(`/api/v1/themes/${theme.id}/images/bogus`);
      expect(res.status).toBe(404);
    });

    test("returns 404 when the slot has no image set", async () => {
      const theme = await seedTheme();
      const res = await client.get(`/api/v1/themes/${theme.id}/images/footer`);
      expect(res.status).toBe(404);
    });

    test("returns 404 for an unknown theme id", async () => {
      const res = await client.get("/api/v1/themes/999999/images/header");
      expect(res.status).toBe(404);
    });

    test("streams the image bytes for a set slot", async () => {
      await seedUserWithRoleAndKey("viewer", "image-key-1");
      const created = await withMultipart(
        client.post("/api/v1/themes").set("Authorization", "Bearer image-key-1"),
        { name: "With image", ...DEFAULT_COLORS },
        { footerBackground: { buffer: Buffer.from("footer-bytes"), filename: "f.png" } },
      );
      expect(created.status).toBe(201);

      const res = await client.get(created.body.images.footerBackgroundUrl);
      expect(res.status).toBe(200);
      expect(res.body.toString()).toBe("footer-bytes");
    });
  });

  describe("PUT /api/v1/me/theme (selectMyTheme)", () => {
    test("selecting a public theme succeeds", async () => {
      await seedUserWithRoleAndKey("viewer", "select-key-1");
      const theme = await seedTheme({ themeOwner: "public" });

      const res = await client
        .put("/api/v1/me/theme")
        .set("Authorization", "Bearer select-key-1")
        .send({ themeId: theme.id });

      expect(res.status).toBe(200);
      expect(res.body.themeId).toBe(theme.id);
      expect(res.body.theme.id).toBe(theme.id);
    });

    test("selecting an owned theme succeeds", async () => {
      const user = await seedUserWithRoleAndKey("viewer", "select-key-2");
      const theme = await seedTheme({ themeOwner: String(user.id) });

      const res = await client
        .put("/api/v1/me/theme")
        .set("Authorization", "Bearer select-key-2")
        .send({ themeId: theme.id });

      expect(res.status).toBe(200);
      expect(res.body.themeId).toBe(theme.id);
    });

    test("selecting someone else's private theme is rejected with 403", async () => {
      const other = await seedUserWithRoleAndKey("viewer", "select-other-key-1");
      await seedUserWithRoleAndKey("viewer", "select-key-3");
      const theme = await seedTheme({ themeOwner: String(other.id) });

      const res = await client
        .put("/api/v1/me/theme")
        .set("Authorization", "Bearer select-key-3")
        .send({ themeId: theme.id });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    test("an unknown themeId returns 400 invalid_body", async () => {
      await seedUserWithRoleAndKey("viewer", "select-key-4");

      const res = await client
        .put("/api/v1/me/theme")
        .set("Authorization", "Bearer select-key-4")
        .send({ themeId: 999999 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_body");
    });

    test("passing themeId: null clears the selection", async () => {
      const user = await seedUserWithRoleAndKey("viewer", "select-key-5");
      const theme = await seedTheme({ themeOwner: "public" });
      await User.update({ themeId: theme.id }, { where: { id: user.id } });

      const res = await client
        .put("/api/v1/me/theme")
        .set("Authorization", "Bearer select-key-5")
        .send({ themeId: null });

      expect(res.status).toBe(200);
      expect(res.body.themeId).toBeNull();
      expect(res.body.theme).toBeNull();
    });
  });

  describe("GET /api/v1/users/:id/theme (getUserTheme)", () => {
    test("a user can read their own selection", async () => {
      const user = await seedUserWithRoleAndKey("viewer", "get-theme-key-1");
      const theme = await seedTheme({ themeOwner: "public" });
      await User.update({ themeId: theme.id }, { where: { id: user.id } });

      const res = await client
        .get(`/api/v1/users/${user.id}/theme`)
        .set("Authorization", "Bearer get-theme-key-1");

      expect(res.status).toBe(200);
      expect(res.body.themeId).toBe(theme.id);
      expect(res.body.theme.id).toBe(theme.id);
    });

    test("a different non-admin user is rejected with 403", async () => {
      const target = await seedUserWithRoleAndKey("viewer", "get-theme-target-key-1");
      await seedUserWithRoleAndKey("viewer", "get-theme-key-2");

      const res = await client
        .get(`/api/v1/users/${target.id}/theme`)
        .set("Authorization", "Bearer get-theme-key-2");

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    test("an admin can read anyone's selection", async () => {
      await seedUserWithRoleAndKey("admin", "get-theme-admin-key-1");
      const target = await seedUserWithRoleAndKey("viewer", "get-theme-target-key-2");

      const res = await client
        .get(`/api/v1/users/${target.id}/theme`)
        .set("Authorization", "Bearer get-theme-admin-key-1");

      expect(res.status).toBe(200);
      expect(res.body.themeId).toBeNull();
      expect(res.body.theme).toBeNull();
    });
  });
});

/**
 * Re-fetches a THEMES row's raw column values (image filenames aren't part
 * of `serializeTheme`'s public URL shape) directly via the model for
 * on-disk-cleanup assertions.
 *
 * @param {number} id THEMES row id.
 * @returns {Promise<import('sequelize').Model>} The row.
 */
async function seedThemeLookup(id) {
  return Theme.findByPk(id);
}
