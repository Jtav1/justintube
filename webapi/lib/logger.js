import pino from "pino";

const LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);

/**
 * Resolves LOG_LEVEL to a valid pino level name, defaulting to "debug"
 * (log everything) when unset or unrecognized.
 *
 * @returns {string} A valid pino level name.
 */
export function resolveLogLevel() {
  const raw = String(process.env.LOG_LEVEL || "debug").toLowerCase();
  return LEVELS.has(raw) ? raw : "debug";
}

/**
 * Shared pino logger instance. Pretty-printed outside production; structured
 * JSON in production (NODE_ENV=production, matching both Dockerfiles).
 *
 * @type {import('pino').Logger}
 */
export const logger = pino({
  level: resolveLogLevel(),
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } },
});
