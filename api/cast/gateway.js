import {
  CAST_NAMESPACE,
  ClientEvents,
  DisplayEvents,
  ServerEvents,
  ServerDisplayEvents,
} from './events.js';
import { publicState } from './session-store.js';

/**
 * Socket.IO gateway for CAST sessions.
 *
 * Ported from dixtube-live's `server/index.js` socket handlers, reshaped from
 * one global room to one Socket.IO room per session (dixtube's global
 * `playerSocketId` becomes per-session `displaySocketId`).
 *
 * Every handler below is a scaffolding stub: the event surface and room
 * plumbing are wired, the behavior is not. Stubbed handlers ack
 * `{ ok: false, error: 'not_implemented' }` when the client passed an ack.
 */

/**
 * Acks (if provided) that the handler is not implemented yet.
 *
 * @param {string} event Event name, for the log line.
 * @param {Function|undefined} ack Optional Socket.IO ack callback.
 * @returns {void} No return value.
 */
function notImplemented(event, ack) {
  console.log(`[cast] "${event}" received — not implemented yet`);
  if (typeof ack === 'function') ack({ ok: false, error: 'not_implemented' });
}

/**
 * Registers the `/cast` namespace and wires every client event.
 *
 * @param {import('socket.io').Server} io Socket.IO server attached to the HTTP server.
 * @param {ReturnType<import('./session-store.js').createSessionStore>} sessionStore Session store.
 * @returns {import('socket.io').Namespace} The `/cast` namespace.
 */
export function attachCastGateway(io, sessionStore) {
  const nsp = io.of(CAST_NAMESPACE);

  /**
   * Broadcasts the session's public snapshot to everyone in its room.
   *
   * @param {string} sessionId Session id (room name).
   * @returns {void} No return value.
   */
  const broadcastState = (sessionId) => {
    const session = sessionStore.getSession(sessionId);
    if (!session) return;
    nsp.to(sessionId).emit(ServerEvents.STATE, publicState(session));
  };

  /**
   * Sends a transport command to the session's display client only.
   *
   * @param {string} sessionId Session id.
   * @param {string} event One of ServerDisplayEvents.
   * @param {unknown} [payload] Event payload.
   * @returns {void} No return value.
   */
  const toDisplay = (sessionId, event, payload) => {
    const session = sessionStore.getSession(sessionId);
    if (!session?.displaySocketId) return;
    nsp.to(session.displaySocketId).emit(event, payload);
  };

  nsp.on('connection', (socket) => {
    /** Session room this socket joined via session:hello, or null. */
    let sessionId = null;

    socket.on(ClientEvents.SESSION_HELLO, ({ sessionId: id, displayName } = {}, ack) => {
      // Room plumbing is real; membership/snapshot logic is not.
      if (typeof id === 'string' && id) {
        sessionId = id;
        socket.join(sessionId);
      }
      // TODO: register member (displayName), emit ServerEvents.STATE snapshot.
      notImplemented(ClientEvents.SESSION_HELLO, ack);
    });

    socket.on(ClientEvents.PRESENCE_SET_NAME, (payload, ack) => {
      // TODO: rename member, emit ACTIVITY, broadcastState(sessionId).
      notImplemented(ClientEvents.PRESENCE_SET_NAME, ack);
    });

    socket.on(ClientEvents.QUEUE_ADD, (payload, ack) => {
      // TODO: resolveVideo(videoId) → addToQueue → auto-start if idle → broadcastState.
      notImplemented(ClientEvents.QUEUE_ADD, ack);
    });

    socket.on(ClientEvents.QUEUE_REMOVE, (payload, ack) => {
      // TODO: removeFromQueue(session, itemId) → ACTIVITY → broadcastState.
      notImplemented(ClientEvents.QUEUE_REMOVE, ack);
    });

    socket.on(ClientEvents.QUEUE_MOVE, (payload, ack) => {
      // TODO: moveInQueue(session, itemId, toIndex) → ACTIVITY → broadcastState.
      notImplemented(ClientEvents.QUEUE_MOVE, ack);
    });

    socket.on(ClientEvents.PLAYER_PLAY, (payload, ack) => {
      // TODO: advance-if-idle or resume; toDisplay(PLAYER_LOAD/PLAYER_PLAY); broadcastState.
      notImplemented(ClientEvents.PLAYER_PLAY, ack);
    });

    socket.on(ClientEvents.PLAYER_PAUSE, (payload, ack) => {
      // TODO: pause playback; toDisplay(PLAYER_PAUSE); broadcastState.
      notImplemented(ClientEvents.PLAYER_PAUSE, ack);
    });

    socket.on(ClientEvents.PLAYER_SKIP, (payload, ack) => {
      // TODO: advance(session); toDisplay(PLAYER_LOAD); ACTIVITY; broadcastState.
      notImplemented(ClientEvents.PLAYER_SKIP, ack);
    });

    socket.on(ClientEvents.PLAYER_PREVIOUS, (payload, ack) => {
      // TODO: previous(session); toDisplay(PLAYER_LOAD); ACTIVITY; broadcastState.
      notImplemented(ClientEvents.PLAYER_PREVIOUS, ack);
    });

    socket.on(ClientEvents.PLAYER_SEEK, (payload, ack) => {
      // TODO: validate seconds; toDisplay(PLAYER_SEEK); emit PLAYER_TICK to room.
      notImplemented(ClientEvents.PLAYER_SEEK, ack);
    });

    socket.on(ClientEvents.REACT, (payload, ack) => {
      // TODO: relay ServerEvents.REACT { emoji, name } to the session room.
      notImplemented(ClientEvents.REACT, ack);
    });

    // ---- Display client ----

    socket.on(DisplayEvents.PLAYER_REGISTER, (payload, ack) => {
      // TODO: set session.displaySocketId = socket.id; resume/load nowPlaying; broadcastState.
      notImplemented(DisplayEvents.PLAYER_REGISTER, ack);
    });

    socket.on(DisplayEvents.PLAYER_STATUS, (payload, ack) => {
      // TODO: only from displaySocketId — update playback, emit PLAYER_TICK to room.
      notImplemented(DisplayEvents.PLAYER_STATUS, ack);
    });

    socket.on(DisplayEvents.PLAYER_ENDED, (payload, ack) => {
      // TODO: only from displaySocketId — advance(session); toDisplay(PLAYER_LOAD); broadcastState.
      notImplemented(DisplayEvents.PLAYER_ENDED, ack);
    });

    socket.on('disconnect', () => {
      // TODO: drop member; if this socket was the display, clear displaySocketId
      // and pause playback; broadcastState(sessionId).
      if (sessionId) console.log(`[cast] socket left session ${sessionId}`);
    });
  });

  // Exposed for future route handlers (e.g. REST queue mutations broadcasting state).
  nsp.broadcastState = broadcastState;
  nsp.toDisplay = toDisplay;

  return nsp;
}
