import { DB_CLIENT, query, exec } from "./db.js";

/**
 * Allowed resolution labels, kept in sync with the OpenAPI `Resolution` enum and
 * the CHECK constraints in the schema DDL.
 *
 * @type {string[]}
 */
const RESOLUTION_VALUES = [
  "240p",
  "360p",
  "480p",
  "720p",
  "1080p",
  "2kHD",
  "4kHD",
];

/**
 * SQL fragment enforcing the resolution CHECK when a column is added in-place.
 *
 * @type {string}
 */
const RESOLUTION_CHECK = `CHECK (resolution IN (${RESOLUTION_VALUES.map(
  (v) => `'${v}'`,
).join(",")}))`;

/**
 * Declarative list of columns that must exist on already-created tables. Each
 * entry is applied only when the column is missing, so this is safe to run on
 * every startup. Types are dialect-specific to match the CREATE TABLE DDL.
 *
 * @type {Array<{table: string, column: string, mysqlType: string, sqliteType: string}>}
 */
const COLUMN_ADDITIONS = [
  {
    table: "ORIGINAL_UPLOADS",
    column: "video_width",
    mysqlType: "INT UNSIGNED NULL",
    sqliteType: "INTEGER",
  },
  {
    table: "ORIGINAL_UPLOADS",
    column: "video_height",
    mysqlType: "INT UNSIGNED NULL",
    sqliteType: "INTEGER",
  },
  {
    table: "ORIGINAL_UPLOADS",
    column: "resolution",
    mysqlType: `VARCHAR(16) NULL ${RESOLUTION_CHECK}`,
    sqliteType: `TEXT ${RESOLUTION_CHECK}`,
  },
];

/**
 * Reports whether a column already exists on a table for the active dialect.
 *
 * @param {string} table Table name to inspect.
 * @param {string} column Column name to look for.
 * @returns {Promise<boolean>} Resolves true when the column is present.
 */
async function columnExists(table, column) {
  if (DB_CLIENT === "mysql") {
    const rows = await query(
      `SELECT 1
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = :table
          AND COLUMN_NAME = :column
        LIMIT 1`,
      { table, column },
    );
    return rows.length > 0;
  }

  // SQLite: PRAGMA cannot be parameterized, but table names come from the
  // trusted COLUMN_ADDITIONS list, so interpolation is safe here.
  const rows = await query(`PRAGMA table_info(${table})`);
  return rows.some((row) => row.name === column);
}

/**
 * Applies any missing column additions in COLUMN_ADDITIONS so databases created
 * before these columns existed are brought up to date. Idempotent: columns that
 * already exist are skipped.
 *
 * @returns {Promise<void>} Resolves once all pending column additions are applied.
 */
export async function applyColumnMigrations() {
  for (const { table, column, mysqlType, sqliteType } of COLUMN_ADDITIONS) {
    if (await columnExists(table, column)) {
      continue;
    }
    const definition = DB_CLIENT === "mysql" ? mysqlType : sqliteType;
    console.log(`[api]: adding column ${table}.${column}`);
    await exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
