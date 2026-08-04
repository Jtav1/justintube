import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { disableDeprecatedNotificationTypes } from "../../lib/seed.js";
import { NotificationType, UserNotificationSetting } from "../../lib/models/index.js";
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
