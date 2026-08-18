import { afterEach, beforeAll, describe, expect, jest, test } from "@jest/globals";
import { NotificationType, UserNotificationSetting } from "../../lib/models/index.js";
import {
  queryRows,
  resetTables,
  seedUser,
  seedUserNotificationSetting,
  setupSchema,
} from "../helpers/db.js";

const mockEmailEnabled = jest.fn().mockReturnValue(false);
const mockSendNotificationEmail = jest.fn().mockResolvedValue(undefined);

// Must run before the dynamic import of lib/notifications.js below - same
// ordering requirement as tests/db/search-reindex.test.js's mock of
// "meilisearch" under native ESM.
jest.unstable_mockModule("../../lib/email/mailer.js", () => ({
  emailEnabled: mockEmailEnabled,
  sendNotificationEmail: mockSendNotificationEmail,
}));

/**
 * Unit tests for lib/notifications.js: the generic in-app + email
 * notification primitive every notification-triggering event (likes,
 * comments, and future types) is meant to call. The mailer is mocked so
 * these exercise the gating logic without touching SMTP.
 *
 * `seedUser` (tests/helpers/db.js) auto-seeds a USER_NOTIFICATION_SETTINGS
 * row per active type, mirroring registration - so every test here starts
 * from real seeded defaults (in-app on for every type; email opt-in for
 * "subscription"/"like"/"comment", opt-out for everything else) rather than
 * an absent row.
 */
describe("createNotification (lib/notifications.js)", () => {
  /** @type {typeof import("../../lib/notifications.js")} */
  let notifications;
  /** @type {number} */
  let likeTypeId;
  /** @type {number} */
  let adminTypeId;

  beforeAll(async () => {
    await setupSchema();
    notifications = await import("../../lib/notifications.js");
    likeTypeId = (await NotificationType.findOne({ where: { name: "like" } })).id;
    adminTypeId = (await NotificationType.findOne({ where: { name: "admin" } })).id;
  });

  afterEach(async () => {
    mockEmailEnabled.mockReset().mockReturnValue(false);
    mockSendNotificationEmail.mockClear();
    await resetTables();
  });

  function notificationsFor(userId) {
    return queryRows("SELECT * FROM NOTIFICATIONS WHERE user_id = :userId", { userId });
  }

  test("does nothing when recipientUserId is falsy", async () => {
    await notifications.createNotification({
      recipientUserId: null,
      typeName: "like",
      title: "t",
      message: "m",
    });

    expect(mockSendNotificationEmail).not.toHaveBeenCalled();
  });

  test("does nothing when actorUserId equals recipientUserId (no self-notify)", async () => {
    const user = await seedUser();

    await notifications.createNotification({
      recipientUserId: user.id,
      actorUserId: user.id,
      typeName: "like",
      title: "t",
      message: "m",
    });

    expect(await notificationsFor(user.id)).toHaveLength(0);
  });

  test("does nothing for an unknown or disabled notification type", async () => {
    const user = await seedUser();

    await notifications.createNotification({
      recipientUserId: user.id,
      typeName: "not-a-real-type",
      title: "t",
      message: "m",
    });

    expect(await notificationsFor(user.id)).toHaveLength(0);
  });

  test("creates a notification with a null target when none is given", async () => {
    const user = await seedUser();

    // In-app delivery is on by default for every type; "admin" is used here
    // to keep this test about target handling, not in-app gating (covered
    // separately below).
    await notifications.createNotification({
      recipientUserId: user.id,
      typeName: "admin",
      title: "Sitewide alert",
      message: "no target here",
    });

    const rows = await notificationsFor(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].target).toBeNull();
  });

  test("creates a notification with the given target, with no actor involved", async () => {
    const user = await seedUser();

    await notifications.createNotification({
      recipientUserId: user.id,
      typeName: "subscriber",
      title: "New subscriber",
      message: "someone subscribed to you",
      target: "some-username",
    });

    const rows = await notificationsFor(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].target).toBe("some-username");
  });

  describe("in-app gating", () => {
    test("does not create an in-app notification once a non-locked type is explicitly disabled", async () => {
      const user = await seedUser();
      const subscriptionTypeId = (await NotificationType.findOne({ where: { name: "subscription" } })).id;
      await seedUserNotificationSetting(user.id, {
        notificationTypeId: subscriptionTypeId,
        enabled: false,
      });

      await notifications.createNotification({
        recipientUserId: user.id,
        typeName: "subscription",
        title: "t",
        message: "m",
      });

      expect(await notificationsFor(user.id)).toHaveLength(0);
    });

    test("creates an in-app notification for a non-locked type by default", async () => {
      const user = await seedUser();

      await notifications.createNotification({
        recipientUserId: user.id,
        typeName: "like",
        title: "t",
        message: "m",
      });

      expect(await notificationsFor(user.id)).toHaveLength(1);
    });

    test("does not create an in-app notification once the user explicitly disables it", async () => {
      const user = await seedUser();
      await seedUserNotificationSetting(user.id, {
        notificationTypeId: likeTypeId,
        enabled: false,
      });

      await notifications.createNotification({
        recipientUserId: user.id,
        typeName: "like",
        title: "t",
        message: "m",
      });

      expect(await notificationsFor(user.id)).toHaveLength(0);
    });

    test.each(["admin", "moderation", "account"])(
      "always creates an in-app notification for the locked type %s, even if disabled in the stored setting",
      async (typeName) => {
        const user = await seedUser();
        const typeId = (await NotificationType.findOne({ where: { name: typeName } })).id;
        // The preferences API rejects setting enabled: false for locked types,
        // but seed a disabled row directly here to prove createNotification
        // itself enforces the lock rather than relying solely on API validation.
        await seedUserNotificationSetting(user.id, {
          notificationTypeId: typeId,
          enabled: false,
        });

        await notifications.createNotification({
          recipientUserId: user.id,
          typeName,
          title: "t",
          message: "m",
        });

        expect(await notificationsFor(user.id)).toHaveLength(1);
      },
    );
  });

  describe("email gating", () => {
    test("does not email an opt-in type (like) by default - the seeded row starts emailEnabled: false", async () => {
      mockEmailEnabled.mockReturnValue(true);
      const user = await seedUser({ email: "owner@example.com" });

      await notifications.createNotification({
        recipientUserId: user.id,
        typeName: "like",
        title: "t",
        message: "m",
      });

      expect(mockSendNotificationEmail).not.toHaveBeenCalled();
      expect((await notificationsFor(user.id))[0].email_status).toBe("not_applicable");
    });

    test("emails an opt-out type (admin) by default - the seeded row starts emailEnabled: true", async () => {
      mockEmailEnabled.mockReturnValue(true);
      const user = await seedUser({ email: "owner@example.com" });

      await notifications.createNotification({
        recipientUserId: user.id,
        typeName: "admin",
        title: "t",
        message: "m",
      });

      expect(mockSendNotificationEmail).toHaveBeenCalledTimes(1);
    });

    test("does not email an opt-out type once the user explicitly disables it", async () => {
      mockEmailEnabled.mockReturnValue(true);
      const user = await seedUser({ email: "owner@example.com" });
      await seedUserNotificationSetting(user.id, {
        notificationTypeId: adminTypeId,
        emailEnabled: false,
      });

      await notifications.createNotification({
        recipientUserId: user.id,
        typeName: "admin",
        title: "t",
        message: "m",
      });

      expect(mockSendNotificationEmail).not.toHaveBeenCalled();
    });

    test("falls back to the type's seeded default when the settings row is unexpectedly missing", async () => {
      mockEmailEnabled.mockReturnValue(true);
      const user = await seedUser({ email: "owner@example.com" });
      // Every user gets a row per active type automatically; delete it to
      // exercise the defensive missing-row fallback path directly.
      await UserNotificationSetting.destroy({
        where: { userId: user.id, notificationTypeId: likeTypeId },
      });

      await notifications.createNotification({
        recipientUserId: user.id,
        typeName: "like",
        title: "t",
        message: "m",
      });

      // "like" defaults to emailEnabled: false, so still no email with no row.
      expect(mockSendNotificationEmail).not.toHaveBeenCalled();
    });

    test("never emails when SMTP is disabled, regardless of preferences", async () => {
      mockEmailEnabled.mockReturnValue(false);
      const user = await seedUser({ email: "owner@example.com" });
      await seedUserNotificationSetting(user.id, {
        notificationTypeId: likeTypeId,
        emailEnabled: true,
      });

      await notifications.createNotification({
        recipientUserId: user.id,
        typeName: "like",
        title: "t",
        message: "m",
      });

      expect(mockSendNotificationEmail).not.toHaveBeenCalled();
    });
  });

  describe("batched email digest queuing (like/comment/subscription)", () => {
    test("queues instead of emailing immediately, once the user explicitly enables email", async () => {
      mockEmailEnabled.mockReturnValue(true);
      const user = await seedUser({ email: "owner@example.com" });
      await seedUserNotificationSetting(user.id, {
        notificationTypeId: likeTypeId,
        emailEnabled: true,
      });

      await notifications.createNotification({
        recipientUserId: user.id,
        typeName: "like",
        title: "Video received a Like",
        message: "m",
        link: "https://example.com/video?v=abc123",
      });

      expect(mockSendNotificationEmail).not.toHaveBeenCalled();
      const rows = await notificationsFor(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].email_status).toBe("pending");
    });

    test("leaves the row not_applicable when the user hasn't opted in to email", async () => {
      mockEmailEnabled.mockReturnValue(true);
      const user = await seedUser({ email: "owner@example.com" });

      await notifications.createNotification({
        recipientUserId: user.id,
        typeName: "comment",
        title: "t",
        message: "m",
      });

      const rows = await notificationsFor(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].email_status).toBe("not_applicable");
    });

    test("leaves the row not_applicable when SMTP is disabled, regardless of preferences", async () => {
      mockEmailEnabled.mockReturnValue(false);
      const user = await seedUser({ email: "owner@example.com" });
      await seedUserNotificationSetting(user.id, {
        notificationTypeId: likeTypeId,
        emailEnabled: true,
      });

      await notifications.createNotification({
        recipientUserId: user.id,
        typeName: "like",
        title: "t",
        message: "m",
      });

      const rows = await notificationsFor(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].email_status).toBe("not_applicable");
    });

    test("queues nothing when there is no in-app row to queue (in-app disabled for the type)", async () => {
      mockEmailEnabled.mockReturnValue(true);
      const user = await seedUser({ email: "owner@example.com" });
      await seedUserNotificationSetting(user.id, {
        notificationTypeId: likeTypeId,
        enabled: false,
        emailEnabled: true,
      });

      await notifications.createNotification({
        recipientUserId: user.id,
        typeName: "like",
        title: "t",
        message: "m",
      });

      expect(mockSendNotificationEmail).not.toHaveBeenCalled();
      expect(await notificationsFor(user.id)).toHaveLength(0);
    });
  });
});
