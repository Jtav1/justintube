import { DB_CLIENT, sequelize } from "./db.js";
import "./models/index.js";
import { seedReferenceData } from "./seed.js";

/**
 * Ensures all application tables and columns exist via Sequelize model sync,
 * then seeds reference data. Safe to run on every startup: `sync({ alter: true })`
 * creates missing tables/columns and `seedReferenceData` is idempotent. The
 * dialect is chosen from DB_CLIENT when the Sequelize instance is constructed.
 *
 * @returns {Promise<void>} Resolves once schema sync and seeding have completed.
 */
export async function ensureSchema() {
  console.log(`[api]: initializing ${DB_CLIENT} database`);
  await sequelize.sync({ alter: true });
  await seedReferenceData();
}
