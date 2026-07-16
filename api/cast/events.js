/**
 * Socket.IO event names for CAST session sync.
 *
 * Single source of truth for the realtime protocol (ported from dixtube-live).
 * Must stay in sync with the event catalog documented on `GET /cast/{id}/sync`
 * in `openapi.yaml`.
 */

/** Client → server events. */
export const ClientEvents = Object.freeze({
  /** Join a session room and receive a `state` snapshot. Payload: `{ sessionId, displayName? }`. */
  SESSION_HELLO: 'session:hello',
  /** Set or change the caller's display name. Payload: `{ name }`. */
  PRESENCE_SET_NAME: 'presence:setName',
  /** Add a video to the session queue. Payload: `{ videoId }`; acks `{ ok, error? }`. */
  QUEUE_ADD: 'queue:add',
  /** Remove a queue entry. Payload: `{ itemId }`. */
  QUEUE_REMOVE: 'queue:remove',
  /** Reorder a queue entry. Payload: `{ itemId, toIndex }`. */
  QUEUE_MOVE: 'queue:move',
  /** Start playback (loads the next queue item if nothing is playing). */
  PLAYER_PLAY: 'player:play',
  /** Pause playback. */
  PLAYER_PAUSE: 'player:pause',
  /** Advance to the next queue item. */
  PLAYER_SKIP: 'player:skip',
  /** Return to the previously played item. */
  PLAYER_PREVIOUS: 'player:previous',
  /** Seek within the current item. Payload: `{ seconds }`. */
  PLAYER_SEEK: 'player:seek',
  /** Broadcast a floating emoji reaction. Payload: `{ emoji }`. */
  REACT: 'react',
});

/** Client → server events sent only by the session's display client. */
export const DisplayEvents = Object.freeze({
  /** Register this socket as the session's display (in-app player/cast-the-tab view). */
  PLAYER_REGISTER: 'player:register',
  /** Report actual playback state so controllers stay truthful. Payload: `{ status, currentTime }`. */
  PLAYER_STATUS: 'player:status',
  /** The current item finished playing (triggers auto-advance). */
  PLAYER_ENDED: 'player:ended',
});

/** Server → client events. */
export const ServerEvents = Object.freeze({
  /** Full CastSession snapshot. */
  STATE: 'state',
  /** Lightweight playback progress. Payload: `{ currentTime, status }`. */
  PLAYER_TICK: 'player:tick',
  /** Activity feed entry. Payload: `{ name, text, at }`. */
  ACTIVITY: 'activity',
  /** Relayed emoji reaction. Payload: `{ emoji, name }`. */
  REACT: 'react',
});

/** Server → display-client events (transport commands relayed to the display). */
export const ServerDisplayEvents = Object.freeze({
  /** Load a queue item into the player. Payload: `{ item }`. */
  PLAYER_LOAD: 'player:load',
  PLAYER_PLAY: 'player:play',
  PLAYER_PAUSE: 'player:pause',
  /** Payload: `{ seconds }`. */
  PLAYER_SEEK: 'player:seek',
});

/** Socket.IO namespace all CAST session traffic uses (one room per session id). */
export const CAST_NAMESPACE = '/cast';
