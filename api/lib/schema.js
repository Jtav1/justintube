import { DB_CLIENT, exec } from "./db.js";
import { applyColumnMigrations } from "./migrations.js";
import {
  SCHEMA_STATEMENTS as MYSQL_SCHEMA_STATEMENTS,
  VIEW_STATEMENTS as MYSQL_VIEW_STATEMENTS,
} from "./schema.mysql.js";
import {
  SCHEMA_STATEMENTS as SQLITE_SCHEMA_STATEMENTS,
  VIEW_STATEMENTS as SQLITE_VIEW_STATEMENTS,
} from "./schema.sqlite.js";

/**
 * Returns the DDL statements for the active database dialect, chosen from the
 * DB_CLIENT env var, split into table statements and view statements.
 *
 * @param {string} dbClient Active database client ("mysql" or "sqlite").
 * @returns {{tables: string[], views: string[]}} Ordered DDL for the dialect.
 */
function schemaStatementsFor(dbClient) {
  switch (dbClient) {
    case "mysql":
      console.log("[api]: initializing mysql database");
      return { tables: MYSQL_SCHEMA_STATEMENTS, views: MYSQL_VIEW_STATEMENTS };
    case "sqlite":
      console.log("[api]: initializing sqlite database");
      return {
        tables: SQLITE_SCHEMA_STATEMENTS,
        views: SQLITE_VIEW_STATEMENTS,
      };
    default:
      throw new Error(
        `Unsupported DB_CLIENT "${dbClient}". Use "sqlite" or "mysql".`,
      );
  }
}

/**
 * Ensures all application tables, columns, and views exist, creating them if
 * necessary. Safe to run on every startup: tables use CREATE TABLE IF NOT
 * EXISTS, missing columns are added in-place, and views are (re)created. The
 * DDL dialect is chosen based on the active DB_CLIENT. Runs in three phases so
 * foreign keys and view column references resolve: tables, then column
 * migrations, then views.
 *
 * @returns {Promise<void>} Resolves once schema creation has completed.
 */
export async function ensureSchema() {
  const { tables, views } = schemaStatementsFor(DB_CLIENT);

  for (const statement of tables) {
    await exec(statement);
  }

  await applyColumnMigrations();

  for (const statement of views) {
    await exec(statement);
  }
}
