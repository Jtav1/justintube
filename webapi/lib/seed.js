import { NotificationType, Role, User } from "./models/index.js";
import { hashPassword } from "./auth/password.js";

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
  {
    name: "unverified",
    description: "Account awaiting email verification.",
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
