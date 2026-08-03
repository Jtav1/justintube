import { afterEach, beforeAll, describe, expect, jest, test } from "@jest/globals";
import { NotificationType } from "../../lib/models/index.js";
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
 */
describe("createNotification (lib/notifications.js)", () => {
  /** @type {typeof import("../../lib/notifications.js")} */
  let notifications;
  /** @type {number} */
  let likeTypeId;

  beforeAll(async () => {
    await setupSchema();
    notifications = await import("../../lib/notifications.js");
    likeTypeId = (await NotificationType.findOne({ where: { name: "like" } })).id;
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

    await notifications.createNotification({
      recipientUserId: user.id,
      typeName: "like",
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

  describe("requireExplicitEmailOptIn: true", () => {
    test("does not email with no preference row, even when SMTP is enabled", async () => {
      mockEmailEnabled.mockReturnValue(true);
      const user = await seedUser({ email: "owner@example.com" });

      await notifications.createNotification({
        recipientUserId: user.id,
        typeName: "like",
        title: "t",
        message: "m",
        requireExplicitEmailOptIn: true,
      });

      expect(mockSendNotificationEmail).not.toHaveBeenCalled();
    });

    test("does not email when the row has emailEnabled: false", async () => {
      mockEmailEnabled.mockReturnValue(true);
      const user = await seedUser({ email: "owner@example.com" });
      await seedUserNotificationSetting(user.id, { notificationTypeId: likeTypeId, emailEnabled: false });

      await notifications.createNotification({
        recipientUserId: user.id,
        typeName: "like",
        title: "t",
        message: "m",
        requireExplicitEmailOptIn: true,
      });

      expect(mockSendNotificationEmail).not.toHaveBeenCalled();
    });

    test("emails when the row has an explicit emailEnabled: true", async () => {
      mockEmailEnabled.mockReturnValue(true);
      const user = await seedUser({ email: "owner@example.com" });
      await seedUserNotificationSetting(user.id, { notificationTypeId: likeTypeId, emailEnabled: true });

      await notifications.createNotification({
        recipientUserId: user.id,
        typeName: "like",
        title: "Video received a Like",
        message: "m",
        link: "https://example.com/video?v=abc123",
        requireExplicitEmailOptIn: true,
      });

      expect(mockSendNotificationEmail).toHaveBeenCalledWith({
        to: "owner@example.com",
        title: "Video received a Like",
        message: "m",
        link: "https://example.com/video?v=abc123",
      });
    });
  });

  describe("requireExplicitEmailOptIn: false (default)", () => {
    test("emails by default when no preference row exists, mirroring the settings UI default", async () => {
      mockEmailEnabled.mockReturnValue(true);
      const user = await seedUser({ email: "owner@example.com" });

      await notifications.createNotification({
        recipientUserId: user.id,
        typeName: "like",
        title: "t",
        message: "m",
      });

      expect(mockSendNotificationEmail).toHaveBeenCalledTimes(1);
    });

    test("does not email when the row has an explicit emailEnabled: false", async () => {
      mockEmailEnabled.mockReturnValue(true);
      const user = await seedUser({ email: "owner@example.com" });
      await seedUserNotificationSetting(user.id, { notificationTypeId: likeTypeId, emailEnabled: false });

      await notifications.createNotification({
        recipientUserId: user.id,
        typeName: "like",
        title: "t",
        message: "m",
      });

      expect(mockSendNotificationEmail).not.toHaveBeenCalled();
    });
  });

  test("never emails when SMTP is disabled, regardless of preferences", async () => {
    mockEmailEnabled.mockReturnValue(false);
    const user = await seedUser({ email: "owner@example.com" });
    await seedUserNotificationSetting(user.id, { notificationTypeId: likeTypeId, emailEnabled: true });

    await notifications.createNotification({
      recipientUserId: user.id,
      typeName: "like",
      title: "t",
      message: "m",
    });

    expect(mockSendNotificationEmail).not.toHaveBeenCalled();
  });
});
