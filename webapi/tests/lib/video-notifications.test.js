import { afterEach, beforeAll, describe, expect, jest, test } from "@jest/globals";
import { NotificationType } from "../../lib/models/index.js";
import {
  queryRows,
  resetTables,
  seedUpload,
  seedUser,
  seedUserNotificationSetting,
  setupSchema,
} from "../helpers/db.js";

const mockEmailEnabled = jest.fn().mockReturnValue(false);
const mockSendNotificationEmail = jest.fn().mockResolvedValue(undefined);

// Must run before the dynamic import of lib/video-notifications.js below —
// same ordering requirement as tests/db/search-reindex.test.js's mock of
// "meilisearch" under native ESM.
jest.unstable_mockModule("../../lib/email/mailer.js", () => ({
  emailEnabled: mockEmailEnabled,
  sendNotificationEmail: mockSendNotificationEmail,
}));

/**
 * Unit tests for lib/video-notifications.js: the in-app + email
 * notification helper called on video like/comment events. The mailer is
 * mocked so these exercise the gating logic (self-notify, missing owner,
 * SMTP-enabled, explicit email opt-in) without touching SMTP.
 */
describe("notifyVideoInteraction (lib/video-notifications.js)", () => {
  /** @type {typeof import("../../lib/video-notifications.js")} */
  let videoNotifications;
  /** @type {number} */
  let likeTypeId;

  beforeAll(async () => {
    await setupSchema();
    videoNotifications = await import("../../lib/video-notifications.js");
    likeTypeId = (await NotificationType.findOne({ where: { name: "like" } })).id;
  });

  afterEach(async () => {
    mockEmailEnabled.mockReset().mockReturnValue(false);
    mockSendNotificationEmail.mockClear();
    await resetTables();
  });

  function ownerNotifications(userId) {
    return queryRows("SELECT * FROM NOTIFICATIONS WHERE user_id = :userId", { userId });
  }

  test("does nothing when the video has no owner", async () => {
    const upload = await seedUpload({ userId: null });

    await videoNotifications.notifyVideoInteraction({
      upload: { userId: null, videoId: upload.videoId, User: null },
      actorUserId: 999,
      typeName: "like",
      title: "Video received a Like",
      message: "someone liked your video",
    });

    expect(mockSendNotificationEmail).not.toHaveBeenCalled();
  });

  test("does nothing when the actor is the owner", async () => {
    const owner = await seedUser({ email: "owner@example.com" });
    const upload = await seedUpload({ userId: owner.id });

    await videoNotifications.notifyVideoInteraction({
      upload: { userId: owner.id, videoId: upload.videoId, User: owner },
      actorUserId: owner.id,
      typeName: "like",
      title: "Video received a Like",
      message: "self-like",
    });

    expect(await ownerNotifications(owner.id)).toHaveLength(0);
    expect(mockSendNotificationEmail).not.toHaveBeenCalled();
  });

  test("creates the in-app notification regardless of email settings", async () => {
    const owner = await seedUser({ email: "owner@example.com" });
    const upload = await seedUpload({ userId: owner.id });

    await videoNotifications.notifyVideoInteraction({
      upload: { userId: owner.id, videoId: upload.videoId, User: owner },
      actorUserId: 999,
      typeName: "like",
      title: "Video received a Like",
      message: "someone liked your video",
    });

    const rows = await ownerNotifications(owner.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].target).toBe(upload.videoId);
    expect(mockSendNotificationEmail).not.toHaveBeenCalled(); // SMTP disabled by default
  });

  test("does not email when SMTP is disabled, even with an explicit opt-in row", async () => {
    mockEmailEnabled.mockReturnValue(false);
    const owner = await seedUser({ email: "owner@example.com" });
    const upload = await seedUpload({ userId: owner.id });
    await seedUserNotificationSetting(owner.id, { notificationTypeId: likeTypeId, emailEnabled: true });

    await videoNotifications.notifyVideoInteraction({
      upload: { userId: owner.id, videoId: upload.videoId, User: owner },
      actorUserId: 999,
      typeName: "like",
      title: "Video received a Like",
      message: "someone liked your video",
    });

    expect(mockSendNotificationEmail).not.toHaveBeenCalled();
  });

  test("does not email when SMTP is enabled but no preference row exists", async () => {
    mockEmailEnabled.mockReturnValue(true);
    const owner = await seedUser({ email: "owner@example.com" });
    const upload = await seedUpload({ userId: owner.id });

    await videoNotifications.notifyVideoInteraction({
      upload: { userId: owner.id, videoId: upload.videoId, User: owner },
      actorUserId: 999,
      typeName: "like",
      title: "Video received a Like",
      message: "someone liked your video",
    });

    expect(mockSendNotificationEmail).not.toHaveBeenCalled();
  });

  test("does not email when the preference row has emailEnabled: false", async () => {
    mockEmailEnabled.mockReturnValue(true);
    const owner = await seedUser({ email: "owner@example.com" });
    const upload = await seedUpload({ userId: owner.id });
    await seedUserNotificationSetting(owner.id, { notificationTypeId: likeTypeId, emailEnabled: false });

    await videoNotifications.notifyVideoInteraction({
      upload: { userId: owner.id, videoId: upload.videoId, User: owner },
      actorUserId: 999,
      typeName: "like",
      title: "Video received a Like",
      message: "someone liked your video",
    });

    expect(mockSendNotificationEmail).not.toHaveBeenCalled();
  });

  test("emails when SMTP is enabled and the row has an explicit emailEnabled: true", async () => {
    mockEmailEnabled.mockReturnValue(true);
    const owner = await seedUser({ email: "owner@example.com" });
    const upload = await seedUpload({ userId: owner.id });
    await seedUserNotificationSetting(owner.id, { notificationTypeId: likeTypeId, emailEnabled: true });

    await videoNotifications.notifyVideoInteraction({
      upload: { userId: owner.id, videoId: upload.videoId, User: owner },
      actorUserId: 999,
      typeName: "like",
      title: "Video received a Like",
      message: "someone liked your video",
    });

    expect(mockSendNotificationEmail).toHaveBeenCalledWith({
      to: "owner@example.com",
      title: "Video received a Like",
      message: "someone liked your video",
      videoId: upload.videoId,
    });
  });

  test("still emails when in-app enabled is false but emailEnabled is true (independent flags)", async () => {
    mockEmailEnabled.mockReturnValue(true);
    const owner = await seedUser({ email: "owner@example.com" });
    const upload = await seedUpload({ userId: owner.id });
    await seedUserNotificationSetting(owner.id, {
      notificationTypeId: likeTypeId,
      enabled: false,
      emailEnabled: true,
    });

    await videoNotifications.notifyVideoInteraction({
      upload: { userId: owner.id, videoId: upload.videoId, User: owner },
      actorUserId: 999,
      typeName: "like",
      title: "Video received a Like",
      message: "someone liked your video",
    });

    expect(mockSendNotificationEmail).toHaveBeenCalledTimes(1);
  });
});
