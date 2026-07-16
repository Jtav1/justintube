/**
 * Persistence seam for CAST sessions.
 *
 * Interface only: dixtube-live's debounced JSON-file persistence is
 * intentionally not carried over. The eventual backing store is SQLite
 * (better-sqlite3, already anticipated by the Dockerfile); until then these
 * are async no-ops so the session store runs purely in memory.
 */

/**
 * @typedef {object} CastPersistence
 * @property {() => Promise<import('./session-store.js').CastSessionState[]>} loadSessions
 * @property {(session: import('./session-store.js').CastSessionState) => Promise<void>} saveSession
 * @property {(id: string) => Promise<void>} deleteSession
 */

/**
 * Creates the (currently no-op) persistence adapter.
 *
 * @returns {CastPersistence} Persistence API.
 */
export function createCastPersistence() {
  return {
    async loadSessions() {
      // TODO: SQLite-backed load.
      return [];
    },
    async saveSession(_session) {
      // TODO: SQLite-backed upsert.
    },
    async deleteSession(_id) {
      // TODO: SQLite-backed delete.
    },
  };
}
