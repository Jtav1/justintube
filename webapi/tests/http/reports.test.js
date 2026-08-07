import {
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "@jest/globals";
import { Report, Role } from "../../lib/models/index.js";
import { createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedReport,
  seedUpload,
  seedUser,
  seedUserApiKey,
  setupSchema,
} from "../helpers/db.js";

/**
 * Seeds a user with the given role name and an API key for Bearer auth.
 *
 * @param {string} roleName Role name (`admin`, `moderator`, `viewer`, …).
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
 * Minimal valid create payload for a report.
 *
 * @param {object} [overrides] Field overrides.
 * @returns {Record<string, unknown>} Create body.
 */
function validCreateBody(overrides = {}) {
  return {
    reportType: "video",
    link: "https://example.com/videos/abc123",
    description: "This video violates the site policy.",
    ...overrides,
  };
}

describe("reports", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("rejects unauthenticated create", async () => {
    const client = createTestClient();
    const res = await client.post("/api/v1/reports").send(validCreateBody());
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("csrf_invalid");
  });

  test("creates reports for each target type", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_report_create";
    const reporter = await seedUserWithRoleAndKey("viewer", rawKey);
    const upload = await seedUpload();
    const target = await seedUser();

    const videoRes = await client
      .post("/api/v1/reports")
      .set("Authorization", `Bearer ${rawKey}`)
      .send(validCreateBody({ reportType: "video", videoId: upload.id }));
    expect(videoRes.status).toBe(201);
    expect(videoRes.body).toMatchObject({
      reportType: "video",
      videoId: upload.id,
      resolved: false,
      reporter: { userId: reporter.id },
    });

    const userRes = await client
      .post("/api/v1/reports")
      .set("Authorization", `Bearer ${rawKey}`)
      .send(validCreateBody({ reportType: "user", reportedUserId: target.id }));
    expect(userRes.status).toBe(201);
    expect(userRes.body).toMatchObject({ reportType: "user", reportedUser: { userId: target.id } });

    const websiteRes = await client
      .post("/api/v1/reports")
      .set("Authorization", `Bearer ${rawKey}`)
      .send(validCreateBody({ reportType: "website" }));
    expect(websiteRes.status).toBe(201);
    expect(websiteRes.body).toMatchObject({ reportType: "website", videoId: null, reportedUser: { userId: null } });
  });

  test("rejects invalid reportType and missing fields", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_report_invalid";
    await seedUserWithRoleAndKey("viewer", rawKey);

    const badType = await client
      .post("/api/v1/reports")
      .set("Authorization", `Bearer ${rawKey}`)
      .send(validCreateBody({ reportType: "spaceship" }));
    expect(badType.status).toBe(400);
    expect(badType.body.error).toBe("invalid_body");

    const missingDescription = await client
      .post("/api/v1/reports")
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ reportType: "system", link: "https://example.com" });
    expect(missingDescription.status).toBe(400);
    expect(missingDescription.body.error).toBe("invalid_body");
  });

  test("lists only my own reports on /reports/mine", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_report_mine";
    const me = await seedUserWithRoleAndKey("viewer", rawKey);
    const other = await seedUser();

    await seedReport(me.id, { description: "mine" });
    await seedReport(other.id, { description: "not mine" });

    const res = await client
      .get("/api/v1/reports/mine")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ description: "mine", reporter: { userId: me.id } });
  });

  test("owner can update description and close (one-way)", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_report_owner_update";
    const owner = await seedUserWithRoleAndKey("viewer", rawKey);
    const report = await seedReport(owner.id, { description: "original" });

    const descUpdate = await client
      .patch(`/api/v1/reports/${report.id}`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ description: "revised" });
    expect(descUpdate.status).toBe(200);
    expect(descUpdate.body.description).toBe("revised");
    expect(descUpdate.body.resolved).toBe(false);

    const close = await client
      .patch(`/api/v1/reports/${report.id}`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ resolved: true });
    expect(close.status).toBe(200);
    expect(close.body.resolved).toBe(true);

    const reopen = await client
      .patch(`/api/v1/reports/${report.id}`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ resolved: false });
    expect(reopen.status).toBe(400);
    expect(reopen.body.error).toBe("invalid_body");
  });

  test("non-owner cannot update another user's report", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_report_non_owner";
    await seedUserWithRoleAndKey("viewer", rawKey);
    const owner = await seedUser();
    const report = await seedReport(owner.id);

    const res = await client
      .patch(`/api/v1/reports/${report.id}`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ description: "hijacked" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("rejects non-moderator on list/get all reports", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_report_viewer_list";
    await seedUserWithRoleAndKey("viewer", rawKey);

    const list = await client
      .get("/api/v1/reports")
      .set("Authorization", `Bearer ${rawKey}`);
    expect(list.status).toBe(403);
    expect(list.body.error).toBe("forbidden");
  });

  test("moderator can list all reports, filter by resolved, and get one", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_report_mod_list";
    await seedUserWithRoleAndKey("moderator", rawKey);
    const reporter = await seedUser();

    const openReport = await seedReport(reporter.id, { resolved: false, description: "open" });
    await seedReport(reporter.id, { resolved: true, description: "resolved" });

    const all = await client
      .get("/api/v1/reports")
      .set("Authorization", `Bearer ${rawKey}`);
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(2);

    const openOnly = await client
      .get("/api/v1/reports?resolved=false")
      .set("Authorization", `Bearer ${rawKey}`);
    expect(openOnly.status).toBe(200);
    expect(openOnly.body.items).toHaveLength(1);
    expect(openOnly.body.items[0].id).toBe(openReport.id);

    const single = await client
      .get(`/api/v1/reports/${openReport.id}`)
      .set("Authorization", `Bearer ${rawKey}`);
    expect(single.status).toBe(200);
    expect(single.body.description).toBe("open");
  });

  test("moderator can resolve and comment; commenter is recorded", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_report_moderate";
    const mod = await seedUserWithRoleAndKey("moderator", rawKey);
    const reporter = await seedUser();
    const report = await seedReport(reporter.id);

    const res = await client
      .patch(`/api/v1/reports/${report.id}/moderate`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ resolved: true, comment: "Reviewed and actioned." });

    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe(true);
    expect(res.body.comment).toBe("Reviewed and actioned.");
    expect(res.body.commenter).toMatchObject({ userId: mod.id });
  });

  test("non-moderator cannot moderate a report", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_report_moderate_forbidden";
    const reporter = await seedUserWithRoleAndKey("viewer", rawKey);
    const report = await seedReport(reporter.id);

    const res = await client
      .patch(`/api/v1/reports/${report.id}/moderate`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ resolved: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("only admin can delete a report", async () => {
    const client = createTestClient();
    const modKey = "jt_test_report_delete_mod";
    const adminKey = "jt_test_report_delete_admin";
    await seedUserWithRoleAndKey("moderator", modKey);
    await seedUserWithRoleAndKey("admin", adminKey);
    const reporter = await seedUser();
    const report = await seedReport(reporter.id);

    const modAttempt = await client
      .delete(`/api/v1/reports/${report.id}`)
      .set("Authorization", `Bearer ${modKey}`);
    expect(modAttempt.status).toBe(403);
    expect(modAttempt.body.error).toBe("forbidden");

    const adminDelete = await client
      .delete(`/api/v1/reports/${report.id}`)
      .set("Authorization", `Bearer ${adminKey}`);
    expect(adminDelete.status).toBe(200);
    expect(adminDelete.body).toEqual({ success: true });
    expect(await Report.findByPk(report.id)).toBeNull();
  });

  test("returns 404 for unknown report on get, update, moderate, and delete", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_report_404";
    await seedUserWithRoleAndKey("admin", rawKey);

    const get = await client
      .get("/api/v1/reports/999999")
      .set("Authorization", `Bearer ${rawKey}`);
    expect(get.status).toBe(404);
    expect(get.body.error).toBe("not_found");

    const patch = await client
      .patch("/api/v1/reports/999999")
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ description: "nope" });
    expect(patch.status).toBe(404);
    expect(patch.body.error).toBe("not_found");

    const moderate = await client
      .patch("/api/v1/reports/999999/moderate")
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ resolved: true });
    expect(moderate.status).toBe(404);
    expect(moderate.body.error).toBe("not_found");

    const del = await client
      .delete("/api/v1/reports/999999")
      .set("Authorization", `Bearer ${rawKey}`);
    expect(del.status).toBe(404);
    expect(del.body.error).toBe("not_found");
  });
});
