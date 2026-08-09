import {
  AccessPermission,
  ApiKeyScope,
  NotificationType,
  Role,
  Theme,
  User,
  UserNotificationSetting,
} from "./models/index.js";
import { hashPassword } from "./auth/password.js";
import { PUBLIC_THEME_OWNER } from "./models/theme.js";

/**
 * The standard authorization roles seeded into the ROLES table. Names are kept
 * in sync with the OpenAPI `Role` enum, and every role is enabled by default.
 *
 * @type {Array<{name: string, description: string}>}
 */
const DEFAULT_ROLES = [
  { name: "admin", description: "Full administrative access to the platform." },
  {
    name: "moderator",
    description: "Can moderate content and manage other users.",
  },
  {
    name: "uploader",
    description: "Verified user who can upload and manage their own videos.",
  },
  { name: "viewer", description: "Default role that can watch and engage." },
  {
    name: "locked",
    description: "Account restricted from most actions.",
  },
];

/**
 * The standard access-grant permission levels seeded into the
 * ACCESS_PERMISSIONS table. Referenced by VIDEO_ACCESS.permissionId and
 * PLAYLIST_ACCESS.permissionId, mirroring how DEFAULT_ROLES backs
 * USERS.roleId.
 *
 * @type {Array<{name: string, description: string}>}
 */
const DEFAULT_ACCESS_PERMISSIONS = [
  { name: "view", description: "Can view the private video/playlist." },
  {
    name: "edit",
    description:
      "Can view and update metadata/content (and, for playlists, add/remove items), " +
      "but cannot delete, change visibility, or manage sharing.",
  },
];

/**
 * The standard API key scopes seeded into the API_KEY_SCOPES table.
 * Referenced by USER_API_KEY_SCOPES.apiKeyScopeId. "full_access" is a
 * superset of the other three rather than something combined with them.
 *
 * @type {Array<{name: string, description: string}>}
 */
const DEFAULT_API_KEY_SCOPES = [
  {
    name: "view_only",
    description: "Read-only access to endpoints the key owner can already view.",
  },
  {
    name: "content_edit",
    description:
      "Create, update, and delete the key owner's videos, playlists, comments, and " +
      "other content, plus content-interaction actions (likes, hides, reports).",
  },
  {
    name: "profile_edit",
    description:
      "Update the key owner's own profile, avatar/banner, theme, notification " +
      "preferences, and subscriptions.",
  },
  {
    name: "full_access",
    description:
      "Full account-equivalent access, including admin actions (if the owner is an " +
      "admin) and managing the owner's own API keys.",
  },
];

/**
 * The standard notification types seeded into the NOTIFICATION_TYPES table.
 * This is the runtime source of truth for available notification types (not
 * a hardcoded constant) — a type can be turned off via its `enabled` column
 * without a code deploy.
 *
 * `defaultEnabled`/`defaultEmailEnabled` are the values a fresh
 * USER_NOTIFICATION_SETTINGS row gets for this type (see
 * `ensureUserNotificationSettings`) — every user gets an explicit row for
 * every active type, so these are the only place "default" preferences are
 * decided; nothing downstream should special-case a missing row anymore.
 * Likes/comments are opt-in (off until the user turns them on); everything
 * else is opt-out (on until the user turns it off).
 *
 * `inAppLocked: true` marks a type whose in-app delivery can't be turned off
 * by the user - moderation actions, account status changes, and sitewide
 * admin broadcasts are important enough that they must always reach the
 * in-app notification list, even though the user can still opt out of the
 * email copy. `createNotification` (lib/notifications.js) and the
 * notification-preferences routes both read this flag rather than
 * hardcoding the type list twice.
 *
 * @type {Array<{name: string, description: string, defaultEnabled: boolean, defaultEmailEnabled: boolean, inAppLocked?: boolean}>}
 */
const DEFAULT_NOTIFICATION_TYPES = [
  {
    name: "subscription",
    description: "New video from one of your subscriptions",
    defaultEnabled: true,
    defaultEmailEnabled: true,
  },
  { name: "like", description: "New like received", defaultEnabled: false, defaultEmailEnabled: false },
  {
    name: "comment",
    description: "New comment received",
    defaultEnabled: false,
    defaultEmailEnabled: false,
  },
  {
    name: "subscriber",
    description: "New subscriber",
    defaultEnabled: true,
    defaultEmailEnabled: true,
  },
  {
    name: "moderation",
    description: "Moderator actions",
    defaultEnabled: true,
    defaultEmailEnabled: true,
    inAppLocked: true,
  },
  {
    name: "account",
    description: "Account status changes",
    defaultEnabled: true,
    defaultEmailEnabled: true,
    inAppLocked: true,
  },
  {
    name: "admin",
    description: "Sitewide alerts & messages",
    defaultEnabled: true,
    defaultEmailEnabled: true,
    inAppLocked: true,
  },
  {
    name: "report",
    description: "Report submissions and moderator updates",
    defaultEnabled: true,
    defaultEmailEnabled: true,
  },
];

/**
 * Fallback default used for a notification type name that isn't found in
 * `DEFAULT_NOTIFICATION_TYPES` (shouldn't happen in practice - every active
 * `NotificationType` row originates from that list).
 *
 * @type {{enabled: boolean, emailEnabled: boolean}}
 */
const FALLBACK_NOTIFICATION_DEFAULTS = { enabled: true, emailEnabled: true };

/**
 * Notification type names that used to be seeded but have since been
 * superseded and removed from `DEFAULT_NOTIFICATION_TYPES`. There is no
 * migration runner (see CLAUDE.md), so an old row for one of these names can
 * still be sitting in NOTIFICATION_TYPES as `enabled: true` from a boot
 * before the rename/removal - left alone, it would keep showing up in every
 * user's notification preferences and keep getting a fresh
 * USER_NOTIFICATION_SETTINGS row for anyone who registers.
 * `disableDeprecatedNotificationTypes` (called on every boot) turns these
 * off rather than deleting the rows, so historical NOTIFICATIONS entries
 * that reference them remain intact and viewable.
 *
 * @type {Record<string, string>} Deprecated type name -> replacement type name.
 */
const DEPRECATED_NOTIFICATION_TYPES = {
  delist: "moderation",
};

/**
 * Returns the seeded default `enabled`/`emailEnabled` values for a
 * notification type name, per `DEFAULT_NOTIFICATION_TYPES`.
 *
 * @param {string} typeName NOTIFICATION_TYPES.name.
 * @returns {{enabled: boolean, emailEnabled: boolean}} Default preference values.
 */
export function getNotificationTypeDefaults(typeName) {
  const entry = DEFAULT_NOTIFICATION_TYPES.find((type) => type.name === typeName);
  if (!entry) {
    return FALLBACK_NOTIFICATION_DEFAULTS;
  }
  return { enabled: entry.defaultEnabled, emailEnabled: entry.defaultEmailEnabled };
}

/**
 * Returns whether a notification type's in-app delivery is locked "on" -
 * users can still opt out of its email copy, but the in-app notification
 * always gets created regardless of their stored `enabled` preference.
 *
 * @param {string} typeName NOTIFICATION_TYPES.name.
 * @returns {boolean} True when in-app delivery for this type can't be disabled.
 */
export function isNotificationTypeInAppLocked(typeName) {
  return DEFAULT_NOTIFICATION_TYPES.some((type) => type.name === typeName && type.inAppLocked === true);
}

/**
 * Inserts the standard authorization roles into the ROLES table if they are not
 * already present. Uses findOrCreate so it is idempotent and safe to run on
 * every startup.
 *
 * @returns {Promise<void>} Resolves once the default roles have been seeded.
 */
export async function seedReferenceData() {
  for (const { name, description } of DEFAULT_ROLES) {
    await Role.findOrCreate({
      where: { name },
      defaults: { description, enabled: true },
    });
  }
  await seedAccessPermissions();
  await seedApiKeyScopes();
  await seedNotificationTypes();
  await disableDeprecatedNotificationTypes();
}

/**
 * Inserts the standard access-grant permission levels ("view", "edit") into
 * the ACCESS_PERMISSIONS table if they are not already present. Uses
 * findOrCreate so it is idempotent and safe to run on every startup. Also
 * called directly (before this function, i.e. before general schema sync) by
 * `migrateAccessPermissionForeignKeys` in schema.js, since VIDEO_ACCESS/
 * PLAYLIST_ACCESS rows need a valid permission id to backfill onto.
 *
 * @returns {Promise<void>} Resolves once the default access permissions have been seeded.
 */
export async function seedAccessPermissions() {
  for (const { name, description } of DEFAULT_ACCESS_PERMISSIONS) {
    await AccessPermission.findOrCreate({
      where: { name },
      defaults: { description },
    });
  }
}

/**
 * Inserts the standard API key scopes ("view_only", "content_edit",
 * "profile_edit", "full_access") into the API_KEY_SCOPES table if they are
 * not already present. Uses findOrCreate so it is idempotent and safe to run
 * on every startup.
 *
 * @returns {Promise<void>} Resolves once the default API key scopes have been seeded.
 */
export async function seedApiKeyScopes() {
  for (const { name, description } of DEFAULT_API_KEY_SCOPES) {
    await ApiKeyScope.findOrCreate({
      where: { name },
      defaults: { description },
    });
  }
}

/**
 * Inserts the standard notification types into the NOTIFICATION_TYPES table
 * if they are not already present. Uses findOrCreate so it is idempotent and
 * safe to run on every startup (and safe to call more than once per boot).
 *
 * @returns {Promise<void>} Resolves once the default notification types have
 *   been seeded.
 */
export async function seedNotificationTypes() {
  for (const { name, description } of DEFAULT_NOTIFICATION_TYPES) {
    await NotificationType.findOrCreate({
      where: { name },
      defaults: { description, enabled: true },
    });
  }
}

/**
 * Disables any NOTIFICATION_TYPES row still `enabled: true` under a name
 * listed in `DEPRECATED_NOTIFICATION_TYPES`, e.g. a leftover "delist" row
 * from before it was superseded by "moderation". Idempotent and safe to run
 * on every boot - once a row is disabled this is a no-op for it.
 *
 * @returns {Promise<void>} Resolves once any deprecated types have been disabled.
 */
export async function disableDeprecatedNotificationTypes() {
  for (const [name, supersededBy] of Object.entries(DEPRECATED_NOTIFICATION_TYPES)) {
    const [count] = await NotificationType.update(
      { enabled: false },
      { where: { name, enabled: true } },
    );
    if (count > 0) {
      console.log(`[api]: disabled deprecated notification type "${name}" (superseded by "${supersededBy}")`);
    }
  }
}

/**
 * Ensures every (user, active notification type) pair has a
 * USER_NOTIFICATION_SETTINGS row, seeded with that type's
 * `defaultEnabled`/`defaultEmailEnabled` values. Idempotent - only inserts
 * pairs that don't already exist.
 *
 * Pass `userId` to scope this to one freshly-created user (called from the
 * registration route so a new account has its rows immediately); omit it to
 * reconcile every user (called on every boot, covering users created before
 * this table existed and any notification type added after they registered).
 *
 * @param {number} [userId] When given, only ensures rows for this user.
 * @returns {Promise<void>} Resolves once any missing rows have been created.
 */
export async function ensureUserNotificationSettings(userId) {
  const userWhere = userId != null ? { id: userId } : {};
  const settingsWhere = userId != null ? { userId } : {};

  const [users, types, existingSettings] = await Promise.all([
    User.findAll({ where: userWhere, attributes: ["id"] }),
    NotificationType.findAll({ where: { enabled: true } }),
    UserNotificationSetting.findAll({
      where: settingsWhere,
      attributes: ["userId", "notificationTypeId"],
    }),
  ]);

  const existingPairs = new Set(
    existingSettings.map((row) => `${row.userId}:${row.notificationTypeId}`),
  );

  const rowsToCreate = [];
  for (const user of users) {
    for (const type of types) {
      if (existingPairs.has(`${user.id}:${type.id}`)) {
        continue;
      }
      const defaults = getNotificationTypeDefaults(type.name);
      rowsToCreate.push({
        userId: user.id,
        notificationTypeId: type.id,
        enabled: defaults.enabled,
        emailEnabled: defaults.emailEnabled,
      });
    }
  }

  if (rowsToCreate.length > 0) {
    await UserNotificationSetting.bulkCreate(rowsToCreate);
  }
}

/**
 * The system-wide public themes seeded on boot. Colors mirror the light- and
 * dark-mode CSS custom properties in `webview/src/index.css` so applying
 * either is a visual no-op until someone customizes it. Mapping:
 * color1=--border, color2=--bg, color3=--text, color4=--text-h,
 * color5=--accent.
 *
 * Exactly one entry must have `isDefault: true` — `GET /api/v1/themes`
 * relies on it as the fallback for callers with no theme selected.
 *
 * @type {Array<{name: string, isDefault: boolean, color1: string, color2: string, color3: string, color4: string, color5: string}>}
 */
const SEEDED_THEMES = [
  {
    name: "Light",
    isDefault: true,
    color1: "E5E4E7",
    color2: "FFFFFF",
    color3: "6B6375",
    color4: "08060D",
    color5: "378bfa",
  },
  {
    name: "Dark",
    isDefault: false,
    color1: "2E303A",
    color2: "16171D",
    color3: "9CA3AF",
    color4: "F3F4F6",
    color5: "2e62ff",
  },
];

/**
 * Ensures the system-wide public themes (Light, Dark) exist, with Light
 * flagged as the fallback `isDefault` theme. Idempotent via findOrCreate,
 * keyed by name.
 *
 * @returns {Promise<void>} Resolves once both themes have been seeded.
 */
export async function seedThemes() {
  for (const { name, ...rest } of SEEDED_THEMES) {
    const [, created] = await Theme.findOrCreate({
      where: { name, themeOwner: PUBLIC_THEME_OWNER },
      defaults: {
        name,
        themeOwner: PUBLIC_THEME_OWNER,
        ...rest,
      },
    });

    if (created) {
      console.log(`[api]: seeded "${name}" theme`);
    }
  }
}

/**
 * Ensures an admin user exists from ADMIN_USERNAME / ADMIN_PASSWORD. Creates
 * the account on first run only; does not overwrite password or role on later
 * startups. Skips with a warning when either env var is missing.
 *
 * @returns {Promise<void>} Resolves once admin seeding has been attempted.
 */
export async function seedAdminUser() {
  const username = String(process.env.ADMIN_USERNAME || "").trim();
  const password = String(process.env.ADMIN_PASSWORD || "");

  if (!username || !password) {
    console.warn(
      "[api]: ADMIN_USERNAME or ADMIN_PASSWORD unset; skipping admin user seed.",
    );
    return;
  }

  const adminRole = await Role.findOne({ where: { name: "admin" } });
  if (!adminRole) {
    console.warn("[api]: admin role missing; skipping admin user seed.");
    return;
  }

  const passwordHash = await hashPassword(password);
  const [, created] = await User.findOrCreate({
    where: { username },
    defaults: {
      username,
      email: `${username}@localhost`,
      displayName: username,
      passwordHash,
      emailVerified: true,
      emailVerifiedAt: new Date(),
      uploader: true,
      roleId: adminRole.id,
    },
  });

  if (created) {
    console.log(`[api]: seeded admin user "${username}"`);
  }
}

/**
 * The standard non-admin demo accounts seeded on boot, for local development
 * and testing. All share the password "password".
 *
 * @type {Array<{username: string, role: string}>}
 */
const DEFAULT_DEMO_USERS = [
  { username: "User1", role: "viewer" },
  { username: "User2", role: "viewer" },
  { username: "Mod1", role: "moderator" },
];

/**
 * Whether `seedDemoUsers()` should run. Independent of `seedAdminUser()`'s
 * env-gate since these accounts (including a "Mod1" moderator) all share the
 * well-known password "password" and must never appear in production unless
 * explicitly requested. Defaults on outside production, off in production;
 * `SEED_DEMO_USERS` overrides either direction.
 *
 * @returns {boolean} True when demo users should be seeded.
 */
export function shouldSeedDemoUsers() {
  const flag = process.env.SEED_DEMO_USERS;
  if (flag !== undefined) {
    return String(flag).toLowerCase() === "true";
  }
  return process.env.NODE_ENV !== "production";
}

/**
 * Ensures the standard non-admin demo accounts (User1, User2, Mod1) exist,
 * each with the password "password". Creates accounts on first run only;
 * does not overwrite password or role on later startups. Idempotent via
 * findOrCreate, safe to call on every boot. Callers should gate this behind
 * `shouldSeedDemoUsers()`.
 *
 * @returns {Promise<void>} Resolves once demo user seeding has been attempted.
 */
export async function seedDemoUsers() {
  for (const { username, role } of DEFAULT_DEMO_USERS) {
    const userRole = await Role.findOne({ where: { name: role } });
    if (!userRole) {
      console.warn(
        `[api]: ${role} role missing; skipping demo user "${username}" seed.`,
      );
      continue;
    }

    const passwordHash = await hashPassword("password");
    const [, created] = await User.findOrCreate({
      where: { username },
      defaults: {
        username,
        email: `${username.toLowerCase()}@localhost`,
        displayName: username,
        passwordHash,
        emailVerified: true,
        emailVerifiedAt: new Date(),
        uploader: true,
        roleId: userRole.id,
      },
    });

    if (created) {
      console.log(`[api]: seeded demo user "${username}"`);
    }
  }
}
