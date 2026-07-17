import { DB_CLIENT, execute } from "./db.js";

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
 * Inserts the standard authorization roles into the ROLES table if they are not
 * already present. Uses a dialect-appropriate insert-ignore so it is idempotent
 * and safe to run on every startup.
 *
 * @returns {Promise<void>} Resolves once the default roles have been seeded.
 */
export async function seedReferenceData() {
  const insertIgnore =
    DB_CLIENT === "mysql" ? "INSERT IGNORE INTO" : "INSERT OR IGNORE INTO";

  for (const { name, description } of DEFAULT_ROLES) {
    await execute(
      `${insertIgnore} ROLES (name, description, enabled)
       VALUES (:name, :description, 1)`,
      { name, description },
    );
  }
}
