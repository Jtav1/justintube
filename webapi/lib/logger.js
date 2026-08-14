const LEVELS = { DEBUG: 0, ERROR: 1, NONE: 2 };

/**
 * Reads LOG_LEVEL and suppresses console output accordingly. DEBUG (default)
 * leaves all console methods untouched; ERROR silences log/warn/debug and
 * keeps error; NONE silences everything. Call once, before any other module
 * has a chance to log.
 *
 * @returns {void}
 */
export function configureLogging() {
  const raw = String(process.env.LOG_LEVEL || "DEBUG").toUpperCase();
  const level = Object.hasOwn(LEVELS, raw) ? raw : "DEBUG";
  const threshold = LEVELS[level];

  if (threshold > LEVELS.DEBUG) {
    console.log = () => {};
    console.debug = () => {};
    console.warn = () => {};
  }
  if (threshold > LEVELS.ERROR) {
    console.error = () => {};
  }
}
