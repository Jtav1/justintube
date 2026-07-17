import { DB_CLIENT, query, exec } from "./db.js";
import {
  ORIGINAL_UPLOADS_DDL,
  USER_PLAYLISTS_DDL,
  VIDEO_LIKES_DDL,
} from "./schema.sqlite.js";

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

/**
 * Declarative list of foreign keys that must exist on already-created content
 * tables now that the USERS table exists. Each entry is applied only when the FK
 * is missing, so this is safe to run on every startup. Fresh databases already
 * carry these FKs from the CREATE TABLE DDL, so nothing is done for them. The
 * `sqliteDdl` is the current table definition, replayed during the SQLite
 * table-rebuild path so the recreated table carries the FK.
 *
 * @type {Array<{table: string, column: string, refTable: string, refColumn: string, onDelete: string, constraint: string, sqliteDdl: string}>}
 */
const FOREIGN_KEY_ADDITIONS = [
  {
    table: "ORIGINAL_UPLOADS",
    column: "user_id",
    refTable: "USERS",
    refColumn: "id",
    onDelete: "SET NULL",
    constraint: "fk_original_uploads_user",
    sqliteDdl: ORIGINAL_UPLOADS_DDL,
  },
  {
    table: "USER_PLAYLISTS",
    column: "user_id",
    refTable: "USERS",
    refColumn: "id",
    onDelete: "CASCADE",
    constraint: "fk_user_playlists_user",
    sqliteDdl: USER_PLAYLISTS_DDL,
  },
  {
    table: "VIDEO_LIKES",
    column: "user_id",
    refTable: "USERS",
    refColumn: "id",
    onDelete: "CASCADE",
    constraint: "fk_video_likes_user",
    sqliteDdl: VIDEO_LIKES_DDL,
  },
];

/**
 * Reports whether a foreign key from a column to a referenced table already
 * exists, for the active dialect.
 *
 * @param {object} spec Foreign key spec from FOREIGN_KEY_ADDITIONS.
 * @param {string} spec.table Table that holds the foreign key column.
 * @param {string} spec.column Foreign key column name.
 * @param {string} spec.refTable Referenced table name.
 * @param {string} spec.constraint Named constraint (MySQL only).
 * @returns {Promise<boolean>} Resolves true when the foreign key is present.
 */
async function foreignKeyExists({ table, column, refTable, constraint }) {
  if (DB_CLIENT === "mysql") {
    const rows = await query(
      `SELECT 1
         FROM information_schema.TABLE_CONSTRAINTS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = :table
          AND CONSTRAINT_NAME = :constraint
          AND CONSTRAINT_TYPE = 'FOREIGN KEY'
        LIMIT 1`,
      { table, constraint },
    );
    return rows.length > 0;
  }

  // SQLite: table names come from the trusted FOREIGN_KEY_ADDITIONS list, so
  // interpolating into the PRAGMA (which cannot be parameterized) is safe.
  const rows = await query(`PRAGMA foreign_key_list(${table})`);
  return rows.some((row) => row.table === refTable && row.from === column);
}

/**
 * Rebuilds a SQLite table so it carries the desired foreign key, using the
 * standard rename/recreate/copy/drop sequence (SQLite cannot ALTER a table to
 * add a foreign key). Foreign key enforcement is toggled off around the swap so
 * existing rows are copied without transient violations.
 *
 * @param {string} table Table to rebuild.
 * @param {string} ddl CREATE TABLE DDL (with the foreign key) for the table.
 * @returns {Promise<void>} Resolves once the table has been rebuilt.
 */
async function rebuildSqliteTableWithForeignKey(table, ddl) {
  const columns = (await query(`PRAGMA table_info(${table})`))
    .map((row) => row.name)
    .join(", ");

  await exec("PRAGMA foreign_keys=OFF");
  await exec("BEGIN");
  try {
    await exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
    await exec(ddl);
    await exec(
      `INSERT INTO ${table} (${columns}) SELECT ${columns} FROM ${table}_old`,
    );
    await exec(`DROP TABLE ${table}_old`);
    await exec("COMMIT");
  } catch (error) {
    await exec("ROLLBACK");
    await exec("PRAGMA foreign_keys=ON");
    throw error;
  }
  await exec("PRAGMA foreign_keys=ON");
}

/**
 * Applies any missing foreign keys in FOREIGN_KEY_ADDITIONS so databases created
 * before the USERS table existed gain the user references. Idempotent: foreign
 * keys that already exist are skipped, so fresh databases (which carry the FK
 * from their CREATE TABLE DDL) are untouched.
 *
 * @returns {Promise<void>} Resolves once all pending foreign keys are applied.
 */
export async function applyForeignKeyMigrations() {
  for (const spec of FOREIGN_KEY_ADDITIONS) {
    if (await foreignKeyExists(spec)) {
      continue;
    }
    console.log(`[api]: adding foreign key ${spec.table}.${spec.column}`);
    if (DB_CLIENT === "mysql") {
      await exec(
        `ALTER TABLE ${spec.table}
           ADD CONSTRAINT ${spec.constraint}
           FOREIGN KEY (${spec.column})
           REFERENCES ${spec.refTable} (${spec.refColumn})
           ON DELETE ${spec.onDelete}`,
      );
      continue;
    }
    await rebuildSqliteTableWithForeignKey(spec.table, spec.sqliteDdl);
  }
}
