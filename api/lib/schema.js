import { QueryTypes } from "sequelize";
import { DB_CLIENT, sequelize } from "./db.js";
import { models } from "./models/index.js";
import { seedReferenceData } from "./seed.js";

/**
 * SQLite views that are no longer part of the application schema and should be
 * dropped on startup rather than preserved or recreated.
 *
 * @type {Set<string>}
 */
const REMOVED_SQLITE_VIEWS = new Set(["USER_VIDEOS"]);

/**
 * Returns the physical table names for all registered Sequelize models.
 *
 * @returns {string[]} Expected application table names.
 */
function getExpectedTableNames() {
  return Object.values(models).map((model) => model.getTableName());
}

/**
 * Escapes a string for use inside a RegExp character class or body.
 *
 * @param {string} value Raw string to escape.
 * @returns {string} RegExp-safe string.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrites foreign keys that still point at temporary `*_old` tables.
 *
 * @param {string} sql Original CREATE TABLE SQL from sqlite_master.
 * @returns {string} SQL with `_old` suffix removed from referenced tables.
 */
function rewriteSqliteOldForeignKeys(sql) {
  return sql.replace(
    /REFERENCES\s+(?:"([^"]+)_old"|`([^`]+)_old`|(\w+)_old)\s*\(/gi,
    (_match, doubleQuoted, backtickQuoted, bare) => {
      const table = doubleQuoted || backtickQuoted || bare;
      return `REFERENCES \`${table}\` (`;
    },
  );
}

/**
 * Builds CREATE TABLE SQL for a repaired copy of an existing table.
 *
 * @param {string} sql Original CREATE TABLE SQL from sqlite_master.
 * @param {string} tableName Existing table name.
 * @param {string} repairName Temporary table name used during recreation.
 * @returns {string} CREATE TABLE statement for the repair copy.
 */
function buildSqliteRepairCreateSql(sql, tableName, repairName) {
  const fixedSql = rewriteSqliteOldForeignKeys(sql);
  return fixedSql.replace(
    new RegExp(
      `^CREATE TABLE\\s+(?:\`|\")?${escapeRegExp(tableName)}(?:\`|\")?`,
      "im",
    ),
    `CREATE TABLE \`${repairName}\``,
  );
}

/**
 * Recreates SQLite tables whose foreign keys still reference temporary
 * `*_old` tables left behind by failed Sequelize alter migrations.
 *
 * @returns {Promise<void>} Resolves once broken foreign keys are repaired.
 */
async function repairSqliteBrokenForeignKeys() {
  const tables = await sequelize.query(
    `SELECT name, sql FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE '%\\_old' ESCAPE '\\'`,
    { type: QueryTypes.SELECT },
  );

  const tablesToRepair = tables.filter(
    ({ sql }) => sql && /_old/.test(sql),
  );
  if (tablesToRepair.length === 0) {
    return;
  }

  const views = await sequelize.query(
    `SELECT name, sql FROM sqlite_master WHERE type = 'view'`,
    { type: QueryTypes.SELECT },
  );
  const viewsToRestore = views.filter(
    ({ name }) => !REMOVED_SQLITE_VIEWS.has(name),
  );

  await sequelize.query("PRAGMA foreign_keys = OFF");
  try {
    for (const view of views) {
      await sequelize.query(`DROP VIEW IF EXISTS \`${view.name}\``);
    }

    for (const { name, sql } of tablesToRepair) {
      const repairName = `${name}__fk_repair`;
      const createRepairSql = buildSqliteRepairCreateSql(sql, name, repairName);

      await sequelize.query("BEGIN");
      try {
        await sequelize.query(createRepairSql);
        await sequelize.query(
          `INSERT INTO \`${repairName}\` SELECT * FROM \`${name}\``,
        );
        await sequelize.query(`DROP TABLE \`${name}\``);
        await sequelize.query(
          `ALTER TABLE \`${repairName}\` RENAME TO \`${name}\``,
        );
        await sequelize.query("COMMIT");
        console.log(`[api]: repaired SQLite foreign keys on ${name}`);
      } catch (error) {
        await sequelize.query("ROLLBACK").catch(() => {});
        throw error;
      }
    }

    for (const view of viewsToRestore) {
      await sequelize.query(view.sql);
    }
  } finally {
    await sequelize.query("PRAGMA foreign_keys = ON");
  }
}

/**
 * Drops legacy SQLite views that are no longer part of the application schema.
 *
 * @returns {Promise<void>} Resolves once removed views have been dropped.
 */
async function dropRemovedSqliteViews() {
  for (const name of REMOVED_SQLITE_VIEWS) {
    await sequelize.query(`DROP VIEW IF EXISTS \`${name}\``);
  }
}

/**
 * Drops leftover temporary tables created by failed Sequelize `alter` runs on
 * SQLite (for example `ORIGINAL_UPLOADS_old`). These orphans break subsequent
 * sync attempts when foreign keys still reference them.
 *
 * @returns {Promise<void>} Resolves once cleanup has finished.
 */
async function cleanupSqliteAlterArtifacts() {
  const rows = await sequelize.query(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE '%\\_old' ESCAPE '\\'`,
    { type: QueryTypes.SELECT },
  );

  for (const { name } of rows) {
    await sequelize.query(`DROP TABLE IF EXISTS \`${name}\``);
  }
}

/**
 * Returns model table names that are not yet present in the SQLite database.
 *
 * @returns {Promise<string[]>} Names of tables that still need to be created.
 */
async function getMissingSqliteTableNames() {
  const expected = getExpectedTableNames();
  const rows = await sequelize.query(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
    { type: QueryTypes.SELECT },
  );
  const existing = new Set(rows.map((row) => row.name));
  return expected.filter((name) => !existing.has(name));
}

/**
 * Ensures all application tables exist on SQLite. Sequelize's SQLite `alter`
 * path is unreliable (it can leave `_old` tables behind and fail on partial
 * schemas), so missing tables are created with a plain `sync()` instead.
 *
 * @returns {Promise<void>} Resolves once all model tables exist.
 */
async function ensureSqliteSchema() {
  await repairSqliteBrokenForeignKeys();
  await cleanupSqliteAlterArtifacts();
  await dropRemovedSqliteViews();

  const missing = await getMissingSqliteTableNames();
  if (missing.length === 0) {
    return;
  }

  console.log(
    `[api]: creating missing SQLite tables: ${missing.join(", ")}`,
  );
  await sequelize.sync();
}

/**
 * Replaces invalid SQLite DATETIME values (for example integer `0` from manual
 * INSERTs) with CURRENT_TIMESTAMP so timestamp columns remain readable.
 *
 * @returns {Promise<void>} Resolves once repairs have finished.
 */
async function repairInvalidSqliteTimestamps() {
  const tables = await sequelize.query(
    `SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE '%\\_old' ESCAPE '\\'`,
    { type: QueryTypes.SELECT },
  );

  for (const { name } of tables) {
    const columns = await sequelize.query(`PRAGMA table_info(\`${name}\`)`, {
      type: QueryTypes.SELECT,
    });

    for (const column of columns) {
      const columnType = String(column.type || "").toUpperCase();
      if (!columnType.includes("DATETIME") && !columnType.includes("DATE")) {
        continue;
      }

      await sequelize.query(
        `UPDATE \`${name}\`
            SET \`${column.name}\` = CURRENT_TIMESTAMP
          WHERE \`${column.name}\` = 0
             OR \`${column.name}\` = '0'
             OR \`${column.name}\` IS NULL`,
      );
    }
  }
}

/**
 * Ensures all application tables and columns exist via Sequelize model sync,
 * then seeds reference data. Safe to run on every startup: MySQL uses
 * `sync({ alter: true })` for missing tables/columns; SQLite creates only
 * missing tables (alter is skipped because it is unreliable there).
 * `seedReferenceData` is idempotent. The dialect is chosen from DB_CLIENT when
 * the Sequelize instance is constructed.
 *
 * @returns {Promise<void>} Resolves once schema sync and seeding have completed.
 */
export async function ensureSchema() {
  console.log(`[api]: initializing ${DB_CLIENT} database`);

  if (DB_CLIENT === "sqlite") {
    await ensureSqliteSchema();
    await repairInvalidSqliteTimestamps();
  } else {
    await sequelize.sync({ alter: true });
  }

  await seedReferenceData();
}
