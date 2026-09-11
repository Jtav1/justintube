import { afterEach, beforeAll, describe, expect, jest, test } from "@jest/globals";
import { Notification, User } from "../../lib/models/index.js";
import { queryRows, resetTables, seedNotification, seedUser, setupSchema } from "../helpers/db.js";

const mockEmailEnabled = jest.fn().mockReturnValue(true);
const mockSendNotificationDigestEmail = jest.fn().mockResolvedValue(undefined);
const mockBuildPublicLink = jest.fn((path) => `https://app.example.com${path}`);

// Must run before the dynamic import of lib/notification-email-digest.js
// below - same ordering requirement as tests/db/search-reindex.test.js's
// mock of "meilisearch" under native ESM.
jest.unstable_mockModule("../../lib/email/mailer.js", () => ({
  emailEnabled: mockEmailEnabled,
  sendNotificationDigestEmail: mockSendNotificationDigestEmail,
  buildPublicLink: mockBuildPublicLink,
}));

/**
 * Tests for lib/notification-email-digest.js: `runNotificationEmailDigest()`
 * batches every `emailStatus: "pending"` notification (queued by
 * `createNotification` for "like"/"comment"/"subscription" - see
 * lib/notifications.js) into one digest email per recipient, capped at 20
 * notifications per email. The mailer is mocked, so these run without SMTP.
 */
describe("Notification email digest (lib/notification-email-digest.js)", () => {
  /** @type {typeof import("../../lib/notification-email-digest.js")} */
  let digest;

  beforeAll(async () => {
    await setupSchema();
    digest = await import("../../lib/notification-email-digest.js");
  });

  afterEach(async () => {
    mockEmailEnabled.mockReset().mockReturnValue(true);
    mockSendNotificationDigestEmail.mockClear().mockResolvedValue(undefined);
    mockBuildPublicLink.mockClear();
    await resetTables();
  });

  function notificationsFor(userId) {
    return queryRows("SELECT * FROM NOTIFICATIONS WHERE user_id = :userId", { userId });
  }

  test("is a no-op when email is not configured", async () => {
    mockEmailEnabled.mockReturnValue(false);
    const user = await seedUser({ email: "owner@example.com" });
    await seedNotification(user.id, { emailStatus: "pending" });

    await digest.runNotificationEmailDigest();

    expect(mockSendNotificationDigestEmail).not.toHaveBeenCalled();
  });

  test("is a no-op when there are no pending notifications", async () => {
    await digest.runNotificationEmailDigest();

    expect(mockSendNotificationDigestEmail).not.toHaveBeenCalled();
  });

  test("ignores rows that aren't pending (not_applicable or already sent)", async () => {
    const user = await seedUser({ email: "owner@example.com" });
    await seedNotification(user.id, { emailStatus: "not_applicable" });
    await seedNotification(user.id, { emailStatus: "sent" });

    await digest.runNotificationEmailDigest();

    expect(mockSendNotificationDigestEmail).not.toHaveBeenCalled();
  });

  test("emails a recipient's pending notifications and marks them sent", async () => {
    const user = await seedUser({ email: "owner@example.com" });
    await seedNotification(user.id, {
      emailStatus: "pending",
      title: "New like",
      message: "Someone liked your video.",
    });
    await seedNotification(user.id, {
      emailStatus: "pending",
      title: "New comment",
      message: "Someone commented on your video.",
    });

    await digest.runNotificationEmailDigest();

    expect(mockSendNotificationDigestEmail).toHaveBeenCalledTimes(1);
    expect(mockSendNotificationDigestEmail).toHaveBeenCalledWith({
      to: "owner@example.com",
      notifications: [
        { title: "New like", message: "Someone liked your video." },
        { title: "New comment", message: "Someone commented on your video." },
      ],
      totalCount: 2,
      link: "https://app.example.com/notifications",
    });

    const rows = await notificationsFor(user.id);
    expect(rows.every((row) => row.email_status === "sent")).toBe(true);
  });

  test("caps a single digest at 20 notifications, leaving the rest pending for the next run", async () => {
    const user = await seedUser({ email: "owner@example.com" });
    for (let i = 0; i < 25; i += 1) {
      await seedNotification(user.id, { emailStatus: "pending", title: `n${i}` });
    }

    await digest.runNotificationEmailDigest();

    expect(mockSendNotificationDigestEmail).toHaveBeenCalledTimes(1);
    const call = mockSendNotificationDigestEmail.mock.calls[0][0];
    expect(call.notifications).toHaveLength(20);
    expect(call.totalCount).toBe(25);

    const rows = await notificationsFor(user.id);
    expect(rows.filter((row) => row.email_status === "sent")).toHaveLength(20);
    expect(rows.filter((row) => row.email_status === "pending")).toHaveLength(5);
  });

  test("sends a separate digest per recipient", async () => {
    const alice = await seedUser({ username: "alice", email: "alice@example.com" });
    const bob = await seedUser({ username: "bob", email: "bob@example.com" });
    await seedNotification(alice.id, { emailStatus: "pending" });
    await seedNotification(bob.id, { emailStatus: "pending" });

    await digest.runNotificationEmailDigest();

    expect(mockSendNotificationDigestEmail).toHaveBeenCalledTimes(2);
    const recipients = mockSendNotificationDigestEmail.mock.calls.map((call) => call[0].to);
    expect(recipients.sort()).toEqual(["alice@example.com", "bob@example.com"]);
  });

  test("marks pending rows sent (without emailing) when the recipient user record is gone", async () => {
    // USERS.email is NOT NULL, so a real "no email" user can't exist - the
    // realistic case this guards is the recipient having been deleted
    // between notification creation and this run; simulate it directly
    // since User.hasMany(Notification, { onDelete: "CASCADE" }) means an
    // actual delete would take the notification row with it too.
    const user = await seedUser({ email: "owner@example.com" });
    await seedNotification(user.id, { emailStatus: "pending" });
    const findByPkSpy = jest.spyOn(User, "findByPk").mockResolvedValueOnce(null);

    await digest.runNotificationEmailDigest();

    findByPkSpy.mockRestore();
    expect(mockSendNotificationDigestEmail).not.toHaveBeenCalled();
    const rows = await notificationsFor(user.id);
    expect(rows[0].email_status).toBe("sent");
  });

  test("isolates a per-recipient send failure without blocking other recipients", async () => {
    const alice = await seedUser({ username: "alice", email: "alice@example.com" });
    const bob = await seedUser({ username: "bob", email: "bob@example.com" });
    await seedNotification(alice.id, { emailStatus: "pending" });
    await seedNotification(bob.id, { emailStatus: "pending" });
    mockSendNotificationDigestEmail.mockImplementation(async ({ to }) => {
      if (to === "alice@example.com") {
        throw new Error("SMTP blip");
      }
    });

    await digest.runNotificationEmailDigest();

    expect(mockSendNotificationDigestEmail).toHaveBeenCalledTimes(2);
    const aliceRows = await notificationsFor(alice.id);
    const bobRows = await notificationsFor(bob.id);
    expect(aliceRows[0].email_status).toBe("pending");
    expect(bobRows[0].email_status).toBe("sent");
  });
});

/**
 * Tests for getNotificationEmailDigestConfig(): reads the cron
 * expression/enabled switch from the environment, same pattern as
 * lib/hash-reconcile.js and lib/search-reindex.js.
 */
describe("getNotificationEmailDigestConfig", () => {
  afterEach(() => {
    delete process.env.NOTIFICATION_EMAIL_DIGEST_CRON;
    delete process.env.NOTIFICATION_EMAIL_DIGEST_ENABLED;
  });

  test("defaults to hourly and enabled", async () => {
    const { getNotificationEmailDigestConfig } = await import(
      "../../lib/notification-email-digest.js"
    );

    expect(getNotificationEmailDigestConfig()).toEqual({ cron: "0 * * * *", enabled: true });
  });

  test("reads overrides from the environment", async () => {
    process.env.NOTIFICATION_EMAIL_DIGEST_CRON = "*/30 * * * *";
    process.env.NOTIFICATION_EMAIL_DIGEST_ENABLED = "false";
    const { getNotificationEmailDigestConfig } = await import(
      "../../lib/notification-email-digest.js"
    );

    expect(getNotificationEmailDigestConfig()).toEqual({
      cron: "*/30 * * * *",
      enabled: false,
    });
  });
});
