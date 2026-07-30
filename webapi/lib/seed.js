import { NotificationType, Role, Theme, User } from "./models/index.js";
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
 * The standard notification types seeded into the NOTIFICATION_TYPES table.
 * This is the runtime source of truth for available notification types (not
 * a hardcoded constant) — a type can be turned off via its `enabled` column
 * without a code deploy.
 *
 * @type {Array<{name: string, description: string}>}
 */
const DEFAULT_NOTIFICATION_TYPES = [
  {
    name: "subscription",
    description: "Someone you're subscribed to uploads a new video.",
  },
  { name: "like", description: "Someone likes your video." },
  { name: "comment", description: "Someone comments on your video." },
  { name: "subscriber", description: "Someone subscribes to your channel." },
];

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
  await seedNotificationTypes();
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
 * Ensures the standard non-admin demo accounts (User1, User2, Mod1) exist,
 * each with the password "password". Creates accounts on first run only;
 * does not overwrite password or role on later startups. Idempotent via
 * findOrCreate, safe to call on every boot.
 *
 * @returns {Promise<void>} Resolves once demo user seeding has been attempted.
 */
export async function seedDemoUsers() {
  for (const { username, role } of DEFAULT_DEMO_USERS) {
    const userRole = await Role.findOne({ where: { name: role } });
    if (!userRole) {
      console.warn(`[api]: ${role} role missing; skipping demo user "${username}" seed.`);
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
