import { randomBytes } from 'node:crypto';

/**
 * Multi-session CAST state store.
 *
 * Room-scoped replacement for dixtube-live's single global `server/state.js`
 * singleton: every session carries its own queue/history/nowPlaying/playback,
 * and mutators operate on a session passed in rather than module state.
 *
 * All mutator bodies are scaffolding stubs (TODO) — the shapes and contracts
 * are final, the logic is not.
 */

/** Most recent history entries exposed in snapshots. */
export const SNAPSHOT_HISTORY_LIMIT = 10;

/**
 * @typedef {object} CastQueueItem
 * @property {string} itemId Unique per queue entry (same video may appear twice).
 * @property {string} videoId
 * @property {string} title
 * @property {string} [thumbnailUrl]
 * @property {number} [durationSeconds]
 * @property {string} addedBy
 * @property {string} addedAt ISO timestamp.
 */

/**
 * @typedef {object} CastPlayback
 * @property {'idle'|'playing'|'paused'} status
 * @property {number} positionSeconds
 * @property {string} updatedAt ISO timestamp.
 */

/**
 * @typedef {object} CastMember
 * @property {string} userId
 * @property {string} username
 * @property {string} displayName
 * @property {'host'|'guest'|'display'} role
 * @property {string} joinedAt ISO timestamp.
 */

/**
 * @typedef {object} CastSessionState
 * @property {string} id
 * @property {string} name
 * @property {string} sessionCode Join code shared with other users.
 * @property {string|null} sourcePlaylistId Playlist the queue was seeded from (never mutated).
 * @property {string} createdBy
 * @property {string} createdAt ISO timestamp.
 * @property {CastQueueItem[]} queue
 * @property {CastQueueItem[]} history Played items, most recent last.
 * @property {CastQueueItem|null} nowPlaying
 * @property {CastPlayback} playback
 * @property {CastMember[]} members
 * @property {string|null} displaySocketId Socket of the registered display client, or null.
 */

/**
 * Generates a human-enterable join code for a new session.
 *
 * @returns {string} Session code.
 */
export function generateSessionCode() {
  // TODO: short, unambiguous, collision-checked code (this is a placeholder).
  return randomBytes(4).toString('hex');
}

/**
 * Creates the in-memory session store.
 *
 * @param {import('./persistence.js').CastPersistence} persistence Persistence seam (async no-ops for now).
 * @returns {{
 *   createSession: (opts: {name?: string, seedItems?: CastQueueItem[], sourcePlaylistId?: string|null, createdBy: string}) => CastSessionState,
 *   getSession: (id: string) => CastSessionState|undefined,
 *   getSessionByCode: (code: string) => CastSessionState|undefined,
 *   endSession: (id: string) => boolean,
 *   listSessions: () => CastSessionState[],
 * }} Store API.
 */
export function createSessionStore(persistence) {
  /** @type {Map<string, CastSessionState>} */
  const sessions = new Map();

  return {
    createSession({ name = '', seedItems = [], sourcePlaylistId = null, createdBy }) {
      /** @type {CastSessionState} */
      const session = {
        id: randomBytes(8).toString('hex'),
        name,
        sessionCode: generateSessionCode(),
        sourcePlaylistId,
        createdBy,
        createdAt: new Date().toISOString(),
        queue: [...seedItems],
        history: [],
        nowPlaying: null,
        playback: { status: 'idle', positionSeconds: 0, updatedAt: new Date().toISOString() },
        members: [],
        displaySocketId: null,
      };
      sessions.set(session.id, session);
      void persistence.saveSession(session);
      return session;
    },

    getSession(id) {
      return sessions.get(id);
    },

    getSessionByCode(code) {
      for (const session of sessions.values()) {
        if (session.sessionCode === code) return session;
      }
      return undefined;
    },

    endSession(id) {
      const existed = sessions.delete(id);
      if (existed) void persistence.deleteSession(id);
      return existed;
    },

    listSessions() {
      return [...sessions.values()];
    },
  };
}

/**
 * Wraps resolved video metadata as a new queue entry.
 *
 * @param {object} media Resolved video fields (see resolve-video.js).
 * @param {string} addedBy Display name of the adding member.
 * @returns {CastQueueItem} New queue item with a fresh itemId.
 */
export function makeQueueItem(media, addedBy) {
  return {
    itemId: randomBytes(8).toString('hex'),
    ...media,
    addedBy: addedBy || 'Anonymous',
    addedAt: new Date().toISOString(),
  };
}

/**
 * Appends a resolved video to the session queue.
 *
 * @param {CastSessionState} session Target session.
 * @param {object} media Resolved video fields.
 * @param {string} addedBy Display name of the adding member.
 * @returns {CastQueueItem|null} The added item, or null.
 */
export function addToQueue(session, media, addedBy) {
  // TODO: port from dixtube-live state.addToQueue (push makeQueueItem, persist).
  return null;
}

/**
 * Removes a queue entry by itemId.
 *
 * @param {CastSessionState} session Target session.
 * @param {string} itemId Queue entry id.
 * @returns {CastQueueItem|null} The removed item, or null if not found.
 */
export function removeFromQueue(session, itemId) {
  // TODO: port from dixtube-live state.removeFromQueue.
  return null;
}

/**
 * Moves a queue entry to a new index (clamped to queue bounds).
 *
 * @param {CastSessionState} session Target session.
 * @param {string} itemId Queue entry id.
 * @param {number} toIndex Destination index.
 * @returns {CastQueueItem|null} The moved item, or null if not found.
 */
export function moveInQueue(session, itemId, toIndex) {
  // TODO: port from dixtube-live state.moveInQueue.
  return null;
}

/**
 * Advances to the next queued item: nowPlaying moves to history, the queue
 * head becomes nowPlaying, playback resets.
 *
 * @param {CastSessionState} session Target session.
 * @returns {CastQueueItem|null} The new nowPlaying, or null if the queue was empty.
 */
export function advance(session) {
  // TODO: port from dixtube-live state.advance (consumptive queue → history).
  return null;
}

/**
 * Returns to the previously played item; the current item goes back to the
 * front of the queue.
 *
 * @param {CastSessionState} session Target session.
 * @returns {CastQueueItem|null} The restored item, or null if history was empty.
 */
export function previous(session) {
  // TODO: port from dixtube-live state.previous.
  return null;
}

/**
 * Builds the public snapshot broadcast as the `state` event and returned by
 * `GET /cast/{id}` (matches the CastSession schema in openapi.yaml).
 *
 * @param {CastSessionState} session Target session.
 * @returns {object} JSON-safe snapshot.
 */
export function publicState(session) {
  return {
    id: session.id,
    name: session.name,
    sessionCode: session.sessionCode,
    sourcePlaylistId: session.sourcePlaylistId,
    createdBy: session.createdBy,
    createdAt: session.createdAt,
    members: session.members,
    queue: session.queue,
    history: session.history.slice(-SNAPSHOT_HISTORY_LIMIT),
    nowPlaying: session.nowPlaying,
    playback: session.playback,
    displayConnected: session.displaySocketId !== null,
  };
}
