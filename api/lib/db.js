import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { QueryTypes, Sequelize } from "sequelize";

/**
 * Selected database client, taken from the DB_CLIENT env var.
 * Supported values: "sqlite" (default, local dev) and "mysql".
 *
 * @type {string}
 */
export const DB_CLIENT = (process.env.DB_CLIENT || "sqlite").toLowerCase();

/**
 * Builds a Sequelize instance for the active DB_CLIENT dialect.
 *
 * @returns {Promise<import('sequelize').Sequelize>} Configured Sequelize instance.
 */
async function createSequelize() {
  if (DB_CLIENT === "mysql") {
    return new Sequelize(
      process.env.MYSQL_DATABASE,
      process.env.MYSQL_USER,
      process.env.MYSQL_PASSWORD,
      {
        dialect: "mysql",
        host: process.env.MYSQL_HOST || "localhost",
        port: Number(process.env.MYSQL_PORT) || 3306,
        logging: false,
        define: {
          freezeTableName: true,
          underscored: true,
        },
        pool: {
          max: Number(process.env.MYSQL_CONNECTION_LIMIT) || 10,
        },
        dialectOptions: {
          charset: "utf8mb4",
        },
      },
    );
  }

  if (DB_CLIENT === "sqlite") {
    const sqlite3 = (await import("sqlite3")).default;
    const configured = process.env.SQLITE_FILE || "db/data/justintube.sqlite";
    const storage = isAbsolute(configured)
      ? configured
      : resolve(process.cwd(), configured);
    mkdirSync(dirname(storage), { recursive: true });

    // Sequelize 6's sqlite dialect requires the node-sqlite3 callback API
    // (not better-sqlite3). Pass the module explicitly for reliable ESM loading.
    const instance = new Sequelize({
      dialect: "sqlite",
      storage,
      dialectModule: sqlite3,
      logging: false,
      define: {
        freezeTableName: true,
        underscored: true,
      },
    });
    patchSqliteDateParsing(instance);
    return instance;
  }

  throw new Error(
    `Unsupported DB_CLIENT "${DB_CLIENT}". Use "sqlite" or "mysql".`,
  );
}

/**
 * Wraps Sequelize's SQLite DATE parser so non-string values (for example integer
 * `0` from manual INSERTs) do not throw when `.includes()` is invoked.
 *
 * @param {import('sequelize').Sequelize} sequelizeInstance Active SQLite instance.
 * @returns {void}
 */
function patchSqliteDateParsing(sequelizeInstance) {
  const SqliteDate = sequelizeInstance.dialect.DataTypes.DATE;
  const baseParse = SqliteDate.parse.bind(SqliteDate);
  SqliteDate.parse = function parseSqliteDate(value, options) {
    if (value == null) {
      return null;
    }
    if (value instanceof Date) {
      return value;
    }
    if (typeof value === "number") {
      return new Date(value);
    }
    if (typeof value !== "string") {
      return new Date(String(value));
    }
    return baseParse(value, options);
  };
}

/**
 * Shared Sequelize instance for the active dialect.
 *
 * @type {import('sequelize').Sequelize}
 */
export const sequelize = await createSequelize();

/**
 * Normalizes a database driver error so it is an `Error` instance in this
 * module's realm while preserving the original message and driver `code`. In
 * production this is a no-op (driver errors are already `Error` instances). It
 * matters under the Jest ESM loader, where the native driver is loaded once per
 * process in the first test file's realm, so its error class fails `instanceof
 * Error` checks (and thus `expect(...).rejects.toThrow()`) in later test files.
 *
 * @param {unknown} error Error thrown by the underlying database driver.
 * @returns {Error} An `Error` instance carrying the original message and code.
 */
function normalizeError(error) {
  if (error instanceof Error) {
    const parentMessage =
      (error.parent && error.parent.message) ||
      (error.original && error.original.message);
    if (
      parentMessage &&
      (!error.message || error.message === "Validation error")
    ) {
      const wrapped = new Error(parentMessage);
      if ("code" in error && error.code !== undefined) {
        wrapped.code = error.code;
      } else if (error.parent && "code" in error.parent) {
        wrapped.code = error.parent.code;
      }
      wrapped.cause = error;
      return wrapped;
    }
    return error;
  }
  const message =
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : String(error);
  const wrapped = new Error(message);
  if (error && typeof error === "object" && "code" in error) {
    wrapped.code = error.code;
  }
  wrapped.cause = error;
  return wrapped;
}

/**
 * Executes a parameterized read query and returns the resulting rows.
 *
 * @param {string} sql SQL statement, optionally containing `:named` placeholders.
 * @param {object} [params] Values bound to the query placeholders.
 * @returns {Promise<Array<object>>} Resolves to the selected rows.
 */
export async function query(sql, params) {
  try {
    return await sequelize.query(sql, {
      ...(params === undefined ? {} : { replacements: params }),
      type: QueryTypes.SELECT,
    });
  } catch (error) {
    throw normalizeError(error);
  }
}

/**
 * Executes a parameterized write query (INSERT/UPDATE/DELETE).
 *
 * @param {string} sql SQL statement, optionally containing `:named` placeholders.
 * @param {object} [params] Values bound to the query placeholders.
 * @returns {Promise<{insertId: number, affectedRows: number}>} Insert id and affected row count.
 */
export async function execute(sql, params) {
  try {
    const queryOptions =
      params === undefined ? {} : { replacements: params };
    const trimmed = sql.trimStart().toUpperCase();
    if (trimmed.startsWith("INSERT")) {
      const [insertId, metadata] = await sequelize.query(sql, {
        ...queryOptions,
        type: QueryTypes.INSERT,
      });
      return {
        insertId: Number(insertId) || 0,
        affectedRows: Number(
          metadata && typeof metadata === "object" && "affectedRows" in metadata
            ? metadata.affectedRows
            : 1,
        ),
      };
    }

    const [, metadata] = await sequelize.query(sql, queryOptions);
    let affectedRows = 0;
    if (typeof metadata === "number") {
      affectedRows = metadata;
    } else if (metadata && typeof metadata === "object") {
      affectedRows = Number(
        metadata.affectedRows ?? metadata.rowCount ?? 0,
      );
    }
    return { insertId: 0, affectedRows };
  } catch (error) {
    throw normalizeError(error);
  }
}

/**
 * Executes one or more raw SQL statements without parameters (e.g. DDL).
 *
 * @param {string} sql Raw SQL to run.
 * @returns {Promise<void>} Resolves once the statement(s) complete.
 */
export async function exec(sql) {
  try {
    await sequelize.query(sql);
  } catch (error) {
    throw normalizeError(error);
  }
}
