import { Role, User } from "../models/index.js";

/**
 * Loads the email addresses of every admin, for best-effort broadcast
 * notifications (e.g. "a new user registered"). `email` is a required column
 * on USERS, but this still trims/filters defensively rather than assuming
 * every row is well-formed.
 *
 * @returns {Promise<string[]>} Admin email addresses (deduplicated, non-empty).
 */
export async function listAdminEmails() {
  const adminRole = await Role.findOne({ where: { name: "admin" } });
  if (!adminRole) {
    return [];
  }

  const admins = await User.findAll({
    where: { roleId: adminRole.id },
    attributes: ["email"],
  });

  const emails = admins
    .map((admin) => String(admin.email || "").trim())
    .filter(Boolean);

  return Array.from(new Set(emails));
}
