import { QueryTypes } from "sequelize";
import { DB_CLIENT, sequelize } from "./db.js";
import { AccessPermission, models, NotificationType } from "./models/index.js";
import {
  seedReferenceData,
  seedAccessPermissions,
  seedAdminUser,
  seedDemoUsers,
  seedThemes,
  seedTranscodeProfiles,
  seedNotificationTypes,
  shouldSeedDemoUsers,
  shouldSeedDefaultTranscodeProfiles,
  ensureUserNotificationSettings,
} from "./seed.js";
import { syncSessionStore } from "./auth/session.js";
import { generateVideoId } from "./video-id.js";
import { logger } from "./logger.js";

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
        logger.info(`[api]: repaired SQLite foreign keys on ${name}`);
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
      table: "USERS",
      column: "banner_filename",
      ddl: "`banner_filename` VARCHAR(255)",
    },
    {
      table: "ORIGINAL_UPLOADS",
      column: "thumbnail_timestamp_tenths",
      ddl: "`thumbnail_timestamp_tenths` INTEGER UNSIGNED NULL",
    },
    {
      table: "ORIGINAL_UPLOADS",
      column: "media_type",
      ddl: "`media_type` VARCHAR(16) NOT NULL DEFAULT 'video'",
    },
    {
      table: "TRANSCODE_PROFILES",
      column: "media_type",
      ddl: "`media_type` VARCHAR(16) NOT NULL DEFAULT 'video'",
    },
    {
      table: "TRANSCODE_PROFILES",
      column: "hardware_accelerated",
      ddl: "`hardware_accelerated` TINYINT(1) NOT NULL DEFAULT 0",
    },
    {
      table: "ORIGINAL_UPLOADS",
      column: "search_index_status",
      ddl: "`search_index_status` VARCHAR(16) NOT NULL DEFAULT 'pending'",
    },
    {
      table: "USER_PLAYLISTS",
      column: "search_index_status",
      ddl: "`search_index_status` VARCHAR(16) NOT NULL DEFAULT 'pending'",
    },
    {
      table: "USERS",
      column: "search_index_status",
      ddl: "`search_index_status` VARCHAR(16) NOT NULL DEFAULT 'pending'",
    },
    {
      table: "ORIGINAL_UPLOADS",
      column: "status_message",
      ddl: "`status_message` VARCHAR(255) NULL",
    },
    {
      table: "USER_PLAYLISTS",
      column: "kind",
      ddl: "`kind` VARCHAR(16) NOT NULL DEFAULT 'standard'",
    },
    {
      table: "NOTIFICATIONS",
      column: "target",
      ddl: "`target` VARCHAR(255) NULL",
    },
    {
      table: "ORIGINAL_UPLOADS",
      column: "content_hash",
      ddl: "`content_hash` VARCHAR(128) NULL",
    },
    {
      table: "ORIGINAL_UPLOADS",
      column: "skip_thumbnail",
      ddl: "`skip_thumbnail` TINYINT(1) NOT NULL DEFAULT 0",
    },
    {
      table: "NOTIFICATIONS",
      column: "deleted",
      ddl: "`deleted` TINYINT(1) NOT NULL DEFAULT 0",
    },
    {
      table: "NOTIFICATIONS",
      column: "email_status",
      ddl: "`email_status` VARCHAR(20) NOT NULL DEFAULT 'not_applicable'",
    },
    {
      table: "COMMENTS",
      column: "deleted_at",
      ddl: "`deleted_at` DATETIME NULL",
    },
    {
      // Backfilled by `npm run migrate-upload-storage` (see webapi/scripts/)
      // - nullable for the same reason the MySQL migration
      // (db/migrations/20260830130000-add-uuid-to-original-uploads.js) adds
      // it nullable: existing rows have no value yet. Was missing from this
      // list entirely, so an existing (pre-per-user-subfolder) SQLite dev DB
      // never got the column even though the model and MySQL migration both
      // already expect it.
      table: "ORIGINAL_UPLOADS",
      column: "uuid",
      ddl: "`uuid` VARCHAR(36) NULL",
    },
    {
      table: "ORIGINAL_UPLOADS",
      column: "embed_video_storage_path",
      ddl: "`embed_video_storage_path` VARCHAR(512) NULL",
    },
    {
      table: "ORIGINAL_UPLOADS",
      column: "embed_video_width",
      ddl: "`embed_video_width` INTEGER UNSIGNED NULL",
    },
    {
      table: "ORIGINAL_UPLOADS",
      column: "embed_video_height",
      ddl: "`embed_video_height` INTEGER UNSIGNED NULL",
    },
    {
      table: "ORIGINAL_UPLOADS",
      column: "embed_video_is_default",
      ddl: "`embed_video_is_default` TINYINT(1) NOT NULL DEFAULT 0",
    },
    {
      table: "ORIGINAL_UPLOADS",
      column: "has_video_stream",
      ddl: "`has_video_stream` TINYINT(1) NULL",
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
    logger.info(`[api]: added SQLite column ${table}.${column}`);
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

  logger.info(`[api]: creating missing SQLite tables: ${missing.join(", ")}`);
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
    logger.info(`[api]: added ${DB_CLIENT} column ${TABLE}.notification_type_id`);
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
    logger.info(`[api]: dropped index uq_user_notification_settings_user_type on ${TABLE}`);
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
    logger.info(`[api]: created index uq_user_notification_settings_user_type_id on ${TABLE}`);
  }

  if (hasOldColumn) {
    await sequelize.query(`ALTER TABLE \`${TABLE}\` DROP COLUMN \`notification_type\``);
    logger.info(`[api]: dropped column ${TABLE}.notification_type`);
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
    logger.info(`[api]: added ${DB_CLIENT} column ${TABLE}.notification_type_id`);
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
    logger.info(`[api]: migrated ${TABLE}.notification_type to notification_type_id`);
  }
}

/**
 * Ensures `VIDEO_ACCESS` and `PLAYLIST_ACCESS` have a `permission_id` foreign
 * key referencing `ACCESS_PERMISSIONS`, backfilling any existing grant row
 * (from before "view"/"edit" permission levels existed) to the seeded "view"
 * permission. Runs before the general sync path (see `ensureSchema`) for the
 * same reason as `migrateNotificationsFk`: that path enforces the model's
 * `allowNull: false` on this column, which would fail on MySQL if any row
 * still had a NULL value when it ran.
 *
 * @returns {Promise<void>} Resolves once both tables have a populated permission_id.
 */
async function migrateAccessPermissionForeignKeys() {
  await AccessPermission.sync();
  await seedAccessPermissions();

  const [viewPermission] = await sequelize.query(
    "SELECT `id` FROM `ACCESS_PERMISSIONS` WHERE `name` = 'view'",
    { type: QueryTypes.SELECT },
  );
  if (!viewPermission) {
    return;
  }

  for (const table of ["VIDEO_ACCESS", "PLAYLIST_ACCESS"]) {
    if (!(await tableExists(table))) {
      continue;
    }

    if (!(await columnExists(table, "permission_id"))) {
      const ddl =
        DB_CLIENT === "sqlite"
          ? "`permission_id` INTEGER"
          : "`permission_id` INT UNSIGNED NULL";
      await sequelize.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
      logger.info(`[api]: added ${DB_CLIENT} column ${table}.permission_id`);
    }

    const [{ count }] = await sequelize.query(
      `SELECT COUNT(*) AS count FROM \`${table}\` WHERE \`permission_id\` IS NULL`,
      { type: QueryTypes.SELECT },
    );
    if (Number(count) > 0) {
      await sequelize.query(
        `UPDATE \`${table}\` SET \`permission_id\` = :viewId WHERE \`permission_id\` IS NULL`,
        { replacements: { viewId: viewPermission.id } },
      );
      logger.info(`[api]: backfilled ${count} ${table}.permission_id value(s) to "view"`);
    }

    if (DB_CLIENT === "mysql") {
      await sequelize.query(
        `ALTER TABLE \`${table}\` MODIFY COLUMN \`permission_id\` INT UNSIGNED NOT NULL`,
      );
    }
  }
}

/**
 * Migrates `ORIGINAL_UPLOADS.uuid_name` (a 36-char UUID) into `video_id` (a
 * 6-character case-sensitive alphanumeric public id): adds the new column,
 * backfills it with freshly generated unique codes, swaps the unique index
 * from the old column to the new one, tightens `video_id` to `NOT NULL` on
 * MySQL, then drops the old column. Guarded/idempotent like its
 * `USER_NOTIFICATION_SETTINGS`/`NOTIFICATIONS` counterparts — safe to run on
 * every boot regardless of migration state.
 *
 * @returns {Promise<void>} Resolves once the table matches the current model.
 */
async function migrateOriginalUploadVideoId() {
  const TABLE = "ORIGINAL_UPLOADS";
  if (!(await tableExists(TABLE))) {
    return;
  }

  if (!(await columnExists(TABLE, "video_id"))) {
    const ddl =
      DB_CLIENT === "sqlite"
        ? "`video_id` VARCHAR BINARY(6)"
        : "`video_id` VARCHAR(6) BINARY NULL";
    await sequelize.query(`ALTER TABLE \`${TABLE}\` ADD COLUMN ${ddl}`);
    logger.info(`[api]: added ${DB_CLIENT} column ${TABLE}.video_id`);
  }

  const hasOldColumn = await columnExists(TABLE, "uuid_name");
  if (hasOldColumn) {
    const existingIds = await sequelize.query(
      `SELECT \`video_id\` FROM \`${TABLE}\` WHERE \`video_id\` IS NOT NULL`,
      { type: QueryTypes.SELECT },
    );
    const used = new Set(existingIds.map((row) => row.video_id));

    const pending = await sequelize.query(
      `SELECT \`id\` FROM \`${TABLE}\` WHERE \`video_id\` IS NULL`,
      { type: QueryTypes.SELECT },
    );
    for (const row of pending) {
      let candidate = generateVideoId();
      while (used.has(candidate)) {
        candidate = generateVideoId();
      }
      used.add(candidate);
      await sequelize.query(
        `UPDATE \`${TABLE}\` SET \`video_id\` = :videoId WHERE \`id\` = :id`,
        { replacements: { videoId: candidate, id: row.id } },
      );
    }
    if (pending.length > 0) {
      logger.info(`[api]: backfilled ${pending.length} ${TABLE}.video_id value(s)`);
    }
  }

  if (await indexExists(TABLE, "uq_uuid_name")) {
    if (DB_CLIENT === "sqlite") {
      await sequelize.query("DROP INDEX `uq_uuid_name`");
    } else {
      await sequelize.query(`ALTER TABLE \`${TABLE}\` DROP INDEX \`uq_uuid_name\``);
    }
    logger.info(`[api]: dropped index uq_uuid_name on ${TABLE}`);
  }

  if (!(await indexExists(TABLE, "uq_video_id"))) {
    if (DB_CLIENT === "sqlite") {
      await sequelize.query(
        `CREATE UNIQUE INDEX \`uq_video_id\` ON \`${TABLE}\` (\`video_id\`)`,
      );
    } else {
      await sequelize.query(
        `ALTER TABLE \`${TABLE}\` ADD UNIQUE INDEX \`uq_video_id\` (\`video_id\`)`,
      );
    }
    logger.info(`[api]: created index uq_video_id on ${TABLE}`);
  }

  if (hasOldColumn) {
    if (DB_CLIENT === "mysql") {
      await sequelize.query(
        `ALTER TABLE \`${TABLE}\` MODIFY COLUMN \`video_id\` VARCHAR(6) BINARY NOT NULL`,
      );
    }
    await sequelize.query(`ALTER TABLE \`${TABLE}\` DROP COLUMN \`uuid_name\``);
    logger.info(`[api]: migrated ${TABLE}.uuid_name to video_id`);
  }
}

/**
 * Migrates `USER_VIEW_HISTORY` from "one row per view" to "one row per
 * (user, upload)": adds the new `updated_at` column (backfilled from
 * `created_at`), collapses any pre-existing repeat-view rows down to the
 * most recent row per (user_id, original_upload_id) pair, drops the old
 * non-unique `idx_user_view_history_user_created` index if present, and adds
 * the `uq_user_view_history_user_upload` unique index the model now expects.
 * Guarded/idempotent like the other `migrate*` helpers — safe to run on every
 * boot regardless of migration state.
 *
 * @returns {Promise<void>} Resolves once the table matches the current model.
 */
async function migrateUserViewHistoryDedup() {
  const TABLE = "USER_VIEW_HISTORY";
  if (!(await tableExists(TABLE))) {
    return;
  }

  if (!(await columnExists(TABLE, "updated_at"))) {
    const ddl = DB_CLIENT === "sqlite" ? "`updated_at` DATETIME" : "`updated_at` DATETIME NULL";
    await sequelize.query(`ALTER TABLE \`${TABLE}\` ADD COLUMN ${ddl}`);
    await sequelize.query(
      `UPDATE \`${TABLE}\` SET \`updated_at\` = \`created_at\` WHERE \`updated_at\` IS NULL`,
    );
    logger.info(`[api]: added ${DB_CLIENT} column ${TABLE}.updated_at`);
  }

  if (!(await indexExists(TABLE, "uq_user_view_history_user_upload"))) {
    if (DB_CLIENT === "sqlite") {
      await sequelize.query(`
        DELETE FROM \`${TABLE}\`
         WHERE \`id\` NOT IN (
           SELECT MAX(\`id\`) FROM \`${TABLE}\` GROUP BY \`user_id\`, \`original_upload_id\`
         )
      `);
    } else {
      await sequelize.query(`
        DELETE t1 FROM \`${TABLE}\` t1
        INNER JOIN \`${TABLE}\` t2
                ON t1.\`user_id\` = t2.\`user_id\`
               AND t1.\`original_upload_id\` = t2.\`original_upload_id\`
               AND t1.\`id\` < t2.\`id\`
      `);
    }
    logger.info(`[api]: deduplicated ${TABLE} rows ahead of unique index creation`);

    if (DB_CLIENT === "sqlite") {
      await sequelize.query(
        `CREATE UNIQUE INDEX \`uq_user_view_history_user_upload\` ON \`${TABLE}\` (\`user_id\`, \`original_upload_id\`)`,
      );
    } else {
      await sequelize.query(
        `ALTER TABLE \`${TABLE}\` ADD UNIQUE INDEX \`uq_user_view_history_user_upload\` (\`user_id\`, \`original_upload_id\`)`,
      );
    }
    logger.info(`[api]: created index uq_user_view_history_user_upload on ${TABLE}`);
  }

  if (await indexExists(TABLE, "idx_user_view_history_user_created")) {
    if (DB_CLIENT === "sqlite") {
      await sequelize.query("DROP INDEX `idx_user_view_history_user_created`");
    } else {
      await sequelize.query(
        `ALTER TABLE \`${TABLE}\` DROP INDEX \`idx_user_view_history_user_created\``,
      );
    }
    logger.info(`[api]: dropped index idx_user_view_history_user_created on ${TABLE}`);
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
 * Migrates `VIDEO_SUBTITLE` from "one row per upload" to "many rows per
 * upload" (e.g. one per language): adds the `label` column (backfilling
 * existing rows with a generic label derived from `source`, since the
 * column is new and had no prior value), then drops the
 * `uq_video_subtitle_upload` unique index that previously enforced at most
 * one subtitle per upload. Guarded/idempotent like the other `migrate*`
 * helpers - safe to run on every boot regardless of migration state.
 *
 * @returns {Promise<void>} Resolves once the table matches the current model.
 */
async function migrateVideoSubtitleLabels() {
  const TABLE = "VIDEO_SUBTITLE";
  if (!(await tableExists(TABLE))) {
    return;
  }

  if (!(await columnExists(TABLE, "label"))) {
    const ddl =
      DB_CLIENT === "sqlite" ? "`label` VARCHAR(100)" : "`label` VARCHAR(100) NULL";
    await sequelize.query(`ALTER TABLE \`${TABLE}\` ADD COLUMN ${ddl}`);
    logger.info(`[api]: added ${DB_CLIENT} column ${TABLE}.label`);

    await sequelize.query(`
      UPDATE \`${TABLE}\`
         SET \`label\` = CASE WHEN \`source\` = 'user' THEN 'Uploaded subtitle' ELSE 'Subtitle' END
       WHERE \`label\` IS NULL
    `);

    if (DB_CLIENT === "mysql") {
      await sequelize.query(
        `ALTER TABLE \`${TABLE}\` MODIFY COLUMN \`label\` VARCHAR(100) NOT NULL`,
      );
    }
    logger.info(`[api]: backfilled ${TABLE}.label for existing rows`);
  }

  if (await indexExists(TABLE, "uq_video_subtitle_upload")) {
    if (DB_CLIENT === "sqlite") {
      await sequelize.query("DROP INDEX `uq_video_subtitle_upload`");
    } else {
      // MySQL refuses to drop an index that's still backing a foreign key
      // (original_upload_id -> ORIGINAL_UPLOADS.id) with
      // "Cannot drop index ... needed in a foreign key constraint" - add a
      // plain, non-unique index on the same column first so the FK has
      // something else to rely on, then the old unique one can go.
      if (!(await indexExists(TABLE, "idx_video_subtitle_upload"))) {
        await sequelize.query(
          `ALTER TABLE \`${TABLE}\` ADD INDEX \`idx_video_subtitle_upload\` (\`original_upload_id\`)`,
        );
      }
      await sequelize.query(
        `ALTER TABLE \`${TABLE}\` DROP INDEX \`uq_video_subtitle_upload\``,
      );
    }
    logger.info(`[api]: dropped index uq_video_subtitle_upload on ${TABLE}`);
  }
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
  logger.info(`[api]: initializing ${DB_CLIENT} database`);

  await migrateOriginalUploadVideoId();
  await migrateUserViewHistoryDedup();
  await migrateNotificationTypeForeignKeys();
  await migrateAccessPermissionForeignKeys();
  await migrateVideoSubtitleLabels();

  if (DB_CLIENT === "sqlite") {
    await ensureSqliteSchema();
    await repairInvalidSqliteTimestamps();
  } else {
    await sequelize.sync({ alter: true });
  }

  await seedReferenceData();
  await seedAdminUser();
  if (shouldSeedDemoUsers()) {
    await seedDemoUsers();
  }
  await seedThemes();
  if (shouldSeedDefaultTranscodeProfiles()) {
    await seedTranscodeProfiles();
  }
  await ensureUserNotificationSettings();
  await syncSessionStore();
}
