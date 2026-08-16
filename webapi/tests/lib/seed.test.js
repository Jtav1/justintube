import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { disableDeprecatedNotificationTypes, seedTranscodeProfiles } from "../../lib/seed.js";
import {
  NotificationType,
  TranscodeProfile,
  UserNotificationSetting,
} from "../../lib/models/index.js";
import { resetTables, seedUser, setupSchema } from "../helpers/db.js";

/**
 * Unit tests for `disableDeprecatedNotificationTypes` (lib/seed.js): the
 * boot-time step that retires a NOTIFICATION_TYPES row left over from before
 * it was renamed/superseded (e.g. "delist" -> "moderation"), without a
 * migration runner to drop or rename it outright.
 */
describe("disableDeprecatedNotificationTypes (lib/seed.js)", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
    await NotificationType.destroy({ where: { name: "delist" }, force: true });
  });

  test("disables a leftover enabled 'delist' row", async () => {
    await NotificationType.create({
      name: "delist",
      description: "A mod delists your video",
      enabled: true,
    });

    await disableDeprecatedNotificationTypes();

    const row = await NotificationType.findOne({ where: { name: "delist" } });
    expect(row.enabled).toBe(false);
  });

  test("is idempotent when 'delist' is already disabled or absent", async () => {
    await expect(disableDeprecatedNotificationTypes()).resolves.toBeUndefined();

    await NotificationType.create({
      name: "delist",
      description: "A mod delists your video",
      enabled: false,
    });
    await expect(disableDeprecatedNotificationTypes()).resolves.toBeUndefined();

    const row = await NotificationType.findOne({ where: { name: "delist" } });
    expect(row.enabled).toBe(false);
  });

  test("a disabled 'delist' row no longer appears in preferences or gets a settings row for new users", async () => {
    const delistType = await NotificationType.create({
      name: "delist",
      description: "A mod delists your video",
      enabled: true,
    });
    await disableDeprecatedNotificationTypes();

    const user = await seedUser();
    const { ensureUserNotificationSettings } = await import("../../lib/seed.js");
    await ensureUserNotificationSettings(user.id);

    const setting = await UserNotificationSetting.findOne({
      where: { userId: user.id, notificationTypeId: delistType.id },
    });
    expect(setting).toBeNull();
  });
});

describe("seedTranscodeProfiles (lib/seed.js)", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("seeds the 5 default video profiles (240p-1080p, H.264/AAC/MP4)", async () => {
    await seedTranscodeProfiles();

    const rows = await TranscodeProfile.findAll({ order: [["outputHeight", "ASC"]] });
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.resolutionName)).toEqual([
      "240p",
      "360p",
      "480p",
      "720p",
      "1080p",
    ]);
    for (const row of rows) {
      expect(row.mediaType).toBe("video");
      expect(row.outputContainer).toBe("mp4");
      expect(row.videoCodec).toBe("h264");
      expect(row.audioCodec).toBe("aac");
      expect(row.hardwareAccelerated).toBe(false);
      expect(row.creatorUserId).toBeNull();
    }
  });

  test("is idempotent - running twice does not duplicate rows", async () => {
    await seedTranscodeProfiles();
    await seedTranscodeProfiles();

    const rows = await TranscodeProfile.findAll();
    expect(rows).toHaveLength(5);
  });

  test("does not recreate a seeded profile an admin has since edited", async () => {
    await seedTranscodeProfiles();

    const profile = await TranscodeProfile.findOne({ where: { resolutionName: "720p" } });
    await profile.update({ videoCodec: "h265" });

    await seedTranscodeProfiles();

    const rows = await TranscodeProfile.findAll({ where: { resolutionName: "720p" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].videoCodec).toBe("h265");
  });
});
