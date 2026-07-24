import session from "express-session";
import connectSessionSequelize from "connect-session-sequelize";
import { sequelize } from "../db.js";

const SequelizeStore = connectSessionSequelize(session.Store);

/**
 * Shared Sequelize-backed session store (single instance per process).
 *
 * @type {InstanceType<typeof SequelizeStore>|null}
 */
let sessionStore = null;

/**
 * Returns (and memoizes) the Sequelize session store for express-session.
 *
 * @returns {InstanceType<typeof SequelizeStore>} Session store instance.
 */
function getSessionStore() {
  if (!sessionStore) {
    sessionStore = new SequelizeStore({
      db: sequelize,
      tableName: "SESSIONS",
    });
  }
  return sessionStore;
}

/**
 * Ensures the Sessions table exists. Safe to call from ensureSchema on startup.
 *
 * @returns {Promise<void>} Resolves once the store schema has been synced.
 */
export async function syncSessionStore() {
  await getSessionStore().sync();
}

/**
 * Parses SESSION_MAX_AGE_MS into a positive integer, defaulting to 7 days.
 *
 * @returns {number} Session cookie max age in milliseconds.
 */
function sessionMaxAgeMs() {
  const parsed = Number(process.env.SESSION_MAX_AGE_MS);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return 7 * 24 * 60 * 60 * 1000;
}

/**
 * Whether the session cookie should set the Secure flag.
 *
 * @returns {boolean} True when SESSION_COOKIE_SECURE is the string "true".
 */
function sessionCookieSecure() {
  return (
    String(process.env.SESSION_COOKIE_SECURE || "").toLowerCase() === "true"
  );
}

/**
 * Resolves the session signing secret from the environment.
 *
 * @returns {string} Session secret string.
 * @throws {Error} When NODE_ENV is production and SESSION_SECRET is missing.
 */
export function resolveSessionSecret() {
  const secret = process.env.SESSION_SECRET || "";
  if (secret) {
    return secret;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET is required when NODE_ENV=production");
  }
  return "dev-insecure-session-secret";
}

/**
 * Builds Express session middleware backed by a Sequelize session store on the
 * shared application database connection.
 *
 * @returns {import('express').RequestHandler} Configured express-session middleware.
 */
export function createSessionMiddleware() {
  return session({
    name: "justintube.sid",
    secret: resolveSessionSecret(),
    resave: false,
    saveUninitialized: false,
    store: getSessionStore(),
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: sessionCookieSecure(),
      maxAge: sessionMaxAgeMs(),
    },
  });
}

/**
 * Promisifies `req.session.regenerate` to avoid session fixation after login.
 *
 * @param {import('express').Request} req Incoming request with a session.
 * @returns {Promise<void>} Resolves once the session id has been rotated.
 */
export function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

/**
 * Promisifies `req.session.destroy`.
 *
 * @param {import('express').Request} req Incoming request with a session.
 * @returns {Promise<void>} Resolves once the session has been destroyed.
 */
export function destroySession(req) {
  return new Promise((resolve, reject) => {
    if (!req.session) {
      resolve();
      return;
    }
    req.session.destroy((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

/**
 * Promisifies `req.session.save` so Set-Cookie is flushed before responding.
 *
 * @param {import('express').Request} req Incoming request with a session.
 * @returns {Promise<void>} Resolves once the session has been persisted.
 */
export function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}
