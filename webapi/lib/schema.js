import { QueryTypes } from "sequelize";
import { DB_CLIENT, sequelize } from "./db.js";
import { models, NotificationType } from "./models/index.js";
import {
  seedReferenceData,
  seedAdminUser,
  seedThemes,
  seedNotificationTypes,
} from "./seed.js";
import { syncSessionStore } from "./auth/session.js";

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
 * Adds known missing columns to existing SQLite tables. Sequelize's SQLite
 * `alter` path is unreliable, so additive column changes are applied here with
 * plain `ALTER TABLE ... ADD COLUMN` when PRAGMA shows they are absent.
 *
 * @returns {Promise<void>} Resolves once any missing columns have been added.
 */
async function ensureSqliteMissingColumns() {
  /** @type {{ table: string, column: string, ddl: string }[]} */
  const additions = [
    {
      table: "USERS",
      column: "password_expired",
      ddl: "`password_expired` TINYINT(1) NOT NULL DEFAULT 0",
    },
    {
      table: "TRANSCODE_PROFILES",
      column: "description",
      ddl: "`description` VARCHAR(250)",
    },
    {
      table: "TRANSCODE_PROFILES",
      column: "resolution_name",
      ddl: "`resolution_name` VARCHAR(10) NOT NULL DEFAULT '720p'",
    },
    {
      table: "USERS",
      column: "avatar_filename",
      ddl: "`avatar_filename` VARCHAR(255)",
    },
    {
      table: "ORIGINAL_UPLOADS",
      column: "thumbnail_timestamp_tenths",
      ddl: "`thumbnail_timestamp_tenths` INTEGER UNSIGNED NULL",
    },
  ];

  for (const { table, column, ddl } of additions) {
    const columns = await sequelize.query(`PRAGMA table_info(\`${table}\`)`, {
      type: QueryTypes.SELECT,
    });
    if (columns.length === 0) {
      continue;
    }
    if (columns.some((col) => col.name === column)) {
      continue;
    }
    await sequelize.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
    console.log(`[api]: added SQLite column ${table}.${column}`);
  }
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
    await ensureSqliteMissingColumns();
    return;
  }

  console.log(
    `[api]: creating missing SQLite tables: ${missing.join(", ")}`,
  );
  await sequelize.sync();
  await ensureSqliteMissingColumns();
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
 * Checks whether a table exists, on either SQLite or MySQL.
 *
 * @param {string} table Physical table name.
 * @returns {Promise<boolean>} True when the table exists.
 */
async function tableExists(table) {
  if (DB_CLIENT === "sqlite") {
    const rows = await sequelize.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = :table",
      { type: QueryTypes.SELECT, replacements: { table } },
    );
    return rows.length > 0;
  }
  const rows = await sequelize.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = :table`,
    { type: QueryTypes.SELECT, replacements: { table } },
  );
  return rows.length > 0;
}

/**
 * Checks whether a column exists on a table, on either SQLite or MySQL.
 *
 * @param {string} table Physical table name.
 * @param {string} column Physical column name.
 * @returns {Promise<boolean>} True when the column exists.
 */
async function columnExists(table, column) {
  if (DB_CLIENT === "sqlite") {
    const columns = await sequelize.query(`PRAGMA table_info(\`${table}\`)`, {
      type: QueryTypes.SELECT,
    });
    return columns.some((col) => col.name === column);
  }
  const rows = await sequelize.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = :table AND column_name = :column`,
    { type: QueryTypes.SELECT, replacements: { table, column } },
  );
  return rows.length > 0;
}

/**
 * Checks whether an index exists (by name) on a table, on either SQLite or MySQL.
 *
 * @param {string} table Physical table name.
 * @param {string} index Index name.
 * @returns {Promise<boolean>} True when the index exists.
 */
async function indexExists(table, index) {
  if (DB_CLIENT === "sqlite") {
    const rows = await sequelize.query(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = :index",
      { type: QueryTypes.SELECT, replacements: { index } },
    );
    return rows.length > 0;
  }
  const rows = await sequelize.query(
    `SELECT 1 FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = :table AND index_name = :index`,
    { type: QueryTypes.SELECT, replacements: { table, index } },
  );
  return rows.length > 0;
}

/**
 * Migrates `USER_NOTIFICATION_SETTINGS.notification_type` (a free-form string)
 * into a `notification_type_id` foreign key referencing NOTIFICATION_TYPES:
 * adds the new column, backfills it by matching the old string to
 * NOTIFICATION_TYPES.name, swaps the unique index from the old column to the
 * new one, then drops the old column. Every step is guarded by an existence
 * check, so this is idempotent and safe to run on every boot regardless of
 * migration state (fresh install, mid-migration, already migrated).
 *
 * @returns {Promise<void>} Resolves once the table matches the current model.
 */
async function migrateUserNotificationSettingsFk() {
  const TABLE = "USER_NOTIFICATION_SETTINGS";
  if (!(await tableExists(TABLE))) {
    return;
  }

  if (!(await columnExists(TABLE, "notification_type_id"))) {
    const ddl =
      DB_CLIENT === "sqlite"
        ? "`notification_type_id` INTEGER"
        : "`notification_type_id` INT UNSIGNED NULL";
    await sequelize.query(`ALTER TABLE \`${TABLE}\` ADD COLUMN ${ddl}`);
    console.log(`[api]: added ${DB_CLIENT} column ${TABLE}.notification_type_id`);
  }

  const hasOldColumn = await columnExists(TABLE, "notification_type");
  if (hasOldColumn) {
    await sequelize.query(`
      UPDATE \`${TABLE}\`
         SET \`notification_type_id\` = (
           SELECT \`id\` FROM \`NOTIFICATION_TYPES\`
            WHERE \`NOTIFICATION_TYPES\`.\`name\` = \`${TABLE}\`.\`notification_type\`
         )
       WHERE \`notification_type_id\` IS NULL
         AND \`notification_type\` IS NOT NULL
    `);
  }

  if (await indexExists(TABLE, "uq_user_notification_settings_user_type")) {
    if (DB_CLIENT === "sqlite") {
      await sequelize.query(
        "DROP INDEX `uq_user_notification_settings_user_type`",
      );
    } else {
      await sequelize.query(
        `ALTER TABLE \`${TABLE}\` DROP INDEX \`uq_user_notification_settings_user_type\``,
      );
    }
    console.log(`[api]: dropped index uq_user_notification_settings_user_type on ${TABLE}`);
  }

  if (!(await indexExists(TABLE, "uq_user_notification_settings_user_type_id"))) {
    if (DB_CLIENT === "sqlite") {
      await sequelize.query(
        `CREATE UNIQUE INDEX \`uq_user_notification_settings_user_type_id\` ON \`${TABLE}\` (\`user_id\`, \`notification_type_id\`)`,
      );
    } else {
      await sequelize.query(
        `ALTER TABLE \`${TABLE}\` ADD UNIQUE INDEX \`uq_user_notification_settings_user_type_id\` (\`user_id\`, \`notification_type_id\`)`,
      );
    }
    console.log(`[api]: created index uq_user_notification_settings_user_type_id on ${TABLE}`);
  }

  if (hasOldColumn) {
    await sequelize.query(`ALTER TABLE \`${TABLE}\` DROP COLUMN \`notification_type\``);
    console.log(`[api]: dropped column ${TABLE}.notification_type`);
  }
}

/**
 * Migrates `NOTIFICATIONS.notification_type` (a string constrained via
 * `constrainedString`) into a `notification_type_id` foreign key referencing
 * NOTIFICATION_TYPES: adds the new column, backfills it, tightens it to
 * `NOT NULL` on MySQL (SQLite has no `ALTER COLUMN`, so it stays physically
 * nullable there and relies on the Sequelize model's `allowNull: false` for
 * enforcement — the same tradeoff `constrainedString` already makes on
 * SQLite), then drops the old column. Guarded/idempotent like its
 * `USER_NOTIFICATION_SETTINGS` counterpart.
 *
 * @returns {Promise<void>} Resolves once the table matches the current model.
 */
async function migrateNotificationsFk() {
  const TABLE = "NOTIFICATIONS";
  if (!(await tableExists(TABLE))) {
    return;
  }

  if (!(await columnExists(TABLE, "notification_type_id"))) {
    const ddl =
      DB_CLIENT === "sqlite"
        ? "`notification_type_id` INTEGER"
        : "`notification_type_id` INT UNSIGNED NULL";
    await sequelize.query(`ALTER TABLE \`${TABLE}\` ADD COLUMN ${ddl}`);
    console.log(`[api]: added ${DB_CLIENT} column ${TABLE}.notification_type_id`);
  }

  if (await columnExists(TABLE, "notification_type")) {
    await sequelize.query(`
      UPDATE \`${TABLE}\`
         SET \`notification_type_id\` = (
           SELECT \`id\` FROM \`NOTIFICATION_TYPES\`
            WHERE \`NOTIFICATION_TYPES\`.\`name\` = \`${TABLE}\`.\`notification_type\`
         )
       WHERE \`notification_type_id\` IS NULL
         AND \`notification_type\` IS NOT NULL
    `);

    if (DB_CLIENT === "mysql") {
      await sequelize.query(
        `ALTER TABLE \`${TABLE}\` MODIFY COLUMN \`notification_type_id\` INT UNSIGNED NOT NULL`,
      );
    }

    await sequelize.query(`ALTER TABLE \`${TABLE}\` DROP COLUMN \`notification_type\``);
    console.log(`[api]: migrated ${TABLE}.notification_type to notification_type_id`);
  }
}

/**
 * Migrates both `USER_NOTIFICATION_SETTINGS` and `NOTIFICATIONS` off their
 * legacy free-form/constrained `notification_type` string columns onto a real
 * `notification_type_id` foreign key referencing NOTIFICATION_TYPES. Runs
 * before the normal sync path (see `ensureSchema`) because that path's
 * emergent column/index add-or-drop timing is unsafe for this specific
 * change on both dialects: a bare SQLite `sync()` would try to add the new
 * unique index before the column it covers exists, and MySQL's
 * `sync({ alter: true })` would drop the old string column before it has been
 * backfilled.
 *
 * @returns {Promise<void>} Resolves once both tables match their models.
 */
async function migrateNotificationTypeForeignKeys() {
  await NotificationType.sync();
  await seedNotificationTypes();
  await migrateUserNotificationSettingsFk();
  await migrateNotificationsFk();
}

/**
 * Ensures all application tables and columns exist via Sequelize model sync,
 * then seeds reference data. Safe to run on every startup: MySQL uses
 * `sync({ alter: true })` for missing tables/columns; SQLite creates only
 * missing tables and applies known additive columns via `ALTER TABLE`
 * (full Sequelize alter is skipped because it is unreliable there).
 * `seedReferenceData` is idempotent. The dialect is chosen from DB_CLIENT when
 * the Sequelize instance is constructed.
 *
 * @returns {Promise<void>} Resolves once schema sync and seeding have completed.
 */
export async function ensureSchema() {
  console.log(`[api]: initializing ${DB_CLIENT} database`);

  await migrateNotificationTypeForeignKeys();

  if (DB_CLIENT === "sqlite") {
    await ensureSqliteSchema();
    await repairInvalidSqliteTimestamps();
  } else {
    await sequelize.sync({ alter: true });
  }

  await seedReferenceData();
  await seedAdminUser();
  await seedThemes();
  await syncSessionStore();
}
