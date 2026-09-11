import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { listAdminEmails } from "../../lib/auth/admin-notifications.js";
import { Role } from "../../lib/models/index.js";
import { resetTables, seedUser, setupSchema } from "../helpers/db.js";

/**
 * Tests for `listAdminEmails()` (lib/auth/admin-notifications.js), the query
 * behind the "new user registered" admin broadcast — exercised directly
 * against the DB rather than through an HTTP route.
 */
describe("listAdminEmails", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("returns emails for admin-role users only, deduplicated", async () => {
    const adminRole = await Role.findOne({ where: { name: "admin" } });
    const viewerRole = await Role.findOne({ where: { name: "viewer" } });
    const moderatorRole = await Role.findOne({ where: { name: "moderator" } });

    await seedUser({ roleId: adminRole.id, email: "admin1@example.com" });
    await seedUser({ roleId: adminRole.id, email: "admin2@example.com" });
    await seedUser({ roleId: viewerRole.id, email: "viewer@example.com" });
    await seedUser({ roleId: moderatorRole.id, email: "mod@example.com" });

    const emails = await listAdminEmails();

    // beforeAll's setupSchema() also seeds a "testadmin" admin account, so
    // this asserts against the two new admin emails rather than the exact
    // full set.
    expect(emails).toEqual(expect.arrayContaining(["admin1@example.com", "admin2@example.com"]));
    expect(emails).not.toContain("viewer@example.com");
    expect(emails).not.toContain("mod@example.com");
    expect(new Set(emails).size).toBe(emails.length);
  });

  test("returns an empty array when there are no admins", async () => {
    const viewerRole = await Role.findOne({ where: { name: "viewer" } });
    await seedUser({ roleId: viewerRole.id, email: "viewer@example.com" });

    const emails = await listAdminEmails();

    expect(emails).toEqual([]);
  });
});
