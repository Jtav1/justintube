import { DB_CLIENT, exec } from "./db.js";
import { SCHEMA_STATEMENTS as MYSQL_SCHEMA_STATEMENTS } from "./schema.mysql.js";
import { SCHEMA_STATEMENTS as SQLITE_SCHEMA_STATEMENTS } from "./schema.sqlite.js";

/**
 * Returns the DDL statements for the active database dialect, chosen from the
 * DB_CLIENT env var.
 *
 * @returns {string[]} Ordered DDL statements for the selected dialect.
 */
function schemaStatementsFor(dbClient) {
  switch (dbClient) {
    case "mysql":
      console.log("[api]: initializing mysql database");
      return MYSQL_SCHEMA_STATEMENTS;
    case "sqlite":
      console.log("[api]: initializing sqlite database");
      return SQLITE_SCHEMA_STATEMENTS;
    default:
      throw new Error(
        `Unsupported DB_CLIENT "${dbClient}". Use "sqlite" or "mysql".`,
      );
  }
}

/**
 * Ensures all application tables exist, creating them if necessary. Safe to run
 * on every startup because each statement uses CREATE TABLE IF NOT EXISTS. The
 * DDL dialect is chosen based on the active DB_CLIENT.
 *
 * @returns {Promise<void>} Resolves once schema creation has completed.
 */
export async function ensureSchema() {
  for (const statement of schemaStatementsFor(DB_CLIENT)) {
    await exec(statement);
  }
}
