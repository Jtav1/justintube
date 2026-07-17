import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * Selected database client, taken from the DB_CLIENT env var.
 * Supported values: "sqlite" (default, local dev) and "mysql".
 *
 * @type {string}
 */
export const DB_CLIENT = (process.env.DB_CLIENT || "sqlite").toLowerCase();

/**
 * @typedef {object} DbBackend
 * @property {(sql: string, params?: object) => Promise<Array<object>>} query Runs a read query, resolving to rows.
 * @property {(sql: string, params?: object) => Promise<{insertId: number, affectedRows: number}>} execute Runs a write query.
 * @property {(sql: string) => Promise<void>} exec Runs one or more raw statements (e.g. DDL) without parameters.
 */

/**
 * Builds the MySQL-backed database backend from the MYSQL_* env vars.
 *
 * @returns {Promise<DbBackend>} Backend whose methods proxy a mysql2 pool.
 */
async function createMysqlBackend() {
  const { default: mysql } = await import("mysql2/promise");
  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT) || 3306,
    database: process.env.MYSQL_DATABASE,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT) || 10,
    waitForConnections: true,
    namedPlaceholders: true,
  });

  return {
    async query(sql, params) {
      const [rows] = await pool.execute(sql, params);
      return rows;
    },
    async execute(sql, params) {
      const [result] = await pool.execute(sql, params);
      return { insertId: result.insertId, affectedRows: result.affectedRows };
    },
    async exec(sql) {
      await pool.query(sql);
    },
  };
}

/**
 * Builds the SQLite-backed database backend, creating the database file (and its
 * parent directory) if needed. The file location comes from SQLITE_FILE and
 * defaults to "db/data/justintube.sqlite" relative to the working directory.
 *
 * @returns {Promise<DbBackend>} Backend whose methods proxy a better-sqlite3 handle.
 */
async function createSqliteBackend() {
  const { default: Database } = await import("better-sqlite3");
  const configured = process.env.SQLITE_FILE || "db/data/justintube.sqlite";
  const file = isAbsolute(configured)
    ? configured
    : resolve(process.cwd(), configured);
  mkdirSync(dirname(file), { recursive: true });

  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  return {
    async query(sql, params) {
      const stmt = db.prepare(sql);
      return params === undefined ? stmt.all() : stmt.all(params);
    },
    async execute(sql, params) {
      const stmt = db.prepare(sql);
      const info = params === undefined ? stmt.run() : stmt.run(params);
      return {
        insertId: Number(info.lastInsertRowid),
        affectedRows: info.changes,
      };
    },
    async exec(sql) {
      db.exec(sql);
    },
  };
}

/** @type {DbBackend} */
const backend =
  DB_CLIENT === "mysql"
    ? await createMysqlBackend()
    : DB_CLIENT === "sqlite"
      ? await createSqliteBackend()
      : (() => {
          throw new Error(
            `Unsupported DB_CLIENT "${DB_CLIENT}". Use "sqlite" or "mysql".`,
          );
        })();

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
    return await backend.query(sql, params);
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
    return await backend.execute(sql, params);
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
    return await backend.exec(sql);
  } catch (error) {
    throw normalizeError(error);
  }
}
