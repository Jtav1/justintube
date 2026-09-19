import { Server } from "socket.io";
import { createCorsOptions } from "../auth/cors.js";
import { getAuthContext } from "../auth/require-auth.js";
import { createSessionMiddleware } from "../auth/session.js";
import { logger } from "../logger.js";
import { CastSession } from "../models/index.js";
import { isReactionEmoji, recordEmojiUse } from "./emoji-usage.js";
import { CastServiceError } from "./errors.js";
import {
  addPlaylistToQueue,
  addQueueItem,
  advanceOnPlaybackEnd,
  controlPlayback,
  endInactiveSessions,
  loadActiveMembership,
  loadSessionById,
  loadSessionSnapshot,
  playbackSnapshot,
  promoteNextQueuedItemIfIdle,
  removeQueueItem,
  reorderQueueItem,
} from "./queue-service.js";

/**
 * lib/cast/realtime.js is the Socket.IO half of CAST: the `/cast` namespace,
 * one room per session (`cast:<id>`), presence tracking, the server-tick
 * playback clock, the `time:sync` clock handshake clients measure their own
 * offset against, and every mutating socket event handler. Every mutation
 * still goes through lib/cast/queue-service.js — this module's job is
 * transport (auth handshake, rooms, broadcasting) and the auto-advance
 * seams (`player:ended`/`player:error`) that only make sense as live events.
 *
 * `attachCastRealtime(httpServer)` is called once from index.js's `start()`,
 * never from `createApp()` - so `tests/helpers/app.js`'s
 * `supertest(createApp())` never boots a real Socket.IO server. Until
 * `attachCastRealtime` runs, the exported `notify*`/`disconnectMember`
 * functions below are no-ops, which is what lets routes/cast.js call them
 * unconditionally without needing to know whether realtime is wired up.
 */

/**
 * The live Socket.IO server, set once by `attachCastRealtime`. Null in any
 * process (or test) that never calls it, which is what makes every
 * `notify*`/`disconnectMember` export below safe to call unconditionally.
 *
 * @type {import('socket.io').Server|null}
 */
let io = null;

/**
 * The playback-clock tick interval, set once by `attachCastRealtime`.
 *
 * @type {NodeJS.Timeout|null}
 */
let tickInterval = null;

/**
 * Number of ticks elapsed, used to persist the playback clock to the
 * database only every 5th tick (~5s) rather than every second.
 *
 * @type {number}
 */
let tickCount = 0;

/**
 * How often (in ticks, ~1s each) the inactivity sweep checks for sessions
 * that have gone 8+ hours without a member-driven action. Every 5 minutes is
 * frequent enough that a stale session doesn't linger much past the
 * threshold, without hammering the DB with a full-table scan every second.
 *
 * @type {number}
 */
const INACTIVITY_SWEEP_INTERVAL_TICKS = 300;

/**
 * In-memory presence: CAST_SESSIONS id -> (user id -> set of live socket
 * ids). Intentionally not persisted - presence is inherently ephemeral and
 * rebuilds itself from zero as clients reconnect after a restart. A
 * session's entry only exists here while at least one socket is connected
 * to its room, which the playback tick loop also uses to know which
 * sessions to bother checking.
 *
 * @type {Map<number, Map<number, Set<string>>>}
 */
const presenceBySession = new Map();

/**
 * The Socket.IO room name for a session.
 *
 * @param {number} sessionId CAST_SESSIONS id.
 * @returns {string} Room name.
 */
function roomName(sessionId) {
  return `cast:${sessionId}`;
}

/**
 * A display name for activity feed / reaction attribution.
 *
 * @param {import('sequelize').Model} user Authenticated user.
 * @returns {string} The user's display name, username, or a fallback.
 */
function displayNameFor(user) {
  return user.displayName || user.username || "Someone";
}

/**
 * Converts a caught error into the `{code, message}` shape sent back in a
 * socket ack's `error` field, logging anything that isn't an expected
 * {@link CastServiceError}.
 *
 * @param {unknown} err The caught error.
 * @returns {{code: string, message: string}} Ack error payload.
 */
function errorPayload(err) {
  if (err instanceof CastServiceError) {
    return { code: err.code, message: err.message };
  }
  logger.error({ err }, "CAST socket handler failed");
  return { code: "internal_error", message: "Something went wrong." };
}

/**
 * Registers a live socket's presence in a session's room.
 *
 * @param {number} sessionId CAST_SESSIONS id.
 * @param {number} userId User id.
 * @param {string} socketId Socket.IO socket id.
 * @returns {void}
 */
function addPresence(sessionId, userId, socketId) {
  let usersMap = presenceBySession.get(sessionId);
  if (!usersMap) {
    usersMap = new Map();
    presenceBySession.set(sessionId, usersMap);
  }
  let socketIds = usersMap.get(userId);
  if (!socketIds) {
    socketIds = new Set();
    usersMap.set(userId, socketIds);
  }
  socketIds.add(socketId);
}

/**
 * Removes a live socket from a session's presence, dropping the user (and
 * the session entry entirely, once empty) when it was their last socket.
 *
 * @param {number} sessionId CAST_SESSIONS id.
 * @param {number} userId User id.
 * @param {string} socketId Socket.IO socket id.
 * @returns {void}
 */
function removePresence(sessionId, userId, socketId) {
  const usersMap = presenceBySession.get(sessionId);
  if (!usersMap) return;
  const socketIds = usersMap.get(userId);
  if (!socketIds) return;
  socketIds.delete(socketId);
  if (socketIds.size === 0) {
    usersMap.delete(userId);
  }
  if (usersMap.size === 0) {
    presenceBySession.delete(sessionId);
  }
}

/**
 * Builds the `presence` event payload for a session from the live map.
 *
 * @param {number} sessionId CAST_SESSIONS id.
 * @returns {{userId: number, online: true}[]} Currently-connected members.
 */
function presenceSnapshot(sessionId) {
  const usersMap = presenceBySession.get(sessionId);
  if (!usersMap) return [];
  return Array.from(usersMap.keys()).map((userId) => ({ userId, online: true }));
}

/**
 * Re-broadcasts the full session snapshot to everyone in its room. The
 * single point every mutation (REST or socket) funnels through so `state:sync`
 * can never drift from what actually happened.
 *
 * @param {number} sessionId CAST_SESSIONS id.
 * @returns {Promise<void>} Resolves once the broadcast is sent (a no-op if realtime isn't attached).
 */
async function broadcastState(sessionId) {
  if (!io) return;
  let session;
  try {
    session = await loadSessionById(sessionId);
  } catch {
    return;
  }
  const snapshot = await loadSessionSnapshot(session);
  io.of("/cast").to(roomName(sessionId)).emit("state:sync", snapshot);
}

/**
 * Broadcasts the current presence list to a session's room.
 *
 * @param {number} sessionId CAST_SESSIONS id.
 * @returns {void}
 */
function broadcastPresence(sessionId) {
  if (!io) return;
  io.of("/cast")
    .to(roomName(sessionId))
    .emit("presence", { members: presenceSnapshot(sessionId) });
}

/**
 * Broadcasts an activity feed entry to a session's room, stamping the
 * server-side timestamp.
 *
 * @param {number} sessionId CAST_SESSIONS id.
 * @param {{type: string, actorName: string, text: string}} entry Activity entry (without `at`).
 * @returns {void}
 */
function broadcastActivity(sessionId, entry) {
  if (!io) return;
  io.of("/cast")
    .to(roomName(sessionId))
    .emit("activity", { ...entry, at: new Date().toISOString() });
}

/**
 * Resolves the session a `session:join` event targets, by numeric id
 * (reconnect) or by join code. Never creates membership - that only happens
 * via the REST `createCastSpace`/`joinCastSpace` endpoints; this purely
 * attaches a live socket to an already-existing membership.
 *
 * @param {{code?: string, sessionId?: number|string}} payload Event payload.
 * @returns {Promise<import('sequelize').Model>} The resolved CAST_SESSIONS row.
 * @throws {CastServiceError} 400 if neither field is given, 404 if unresolvable.
 */
async function resolveJoinTarget({ code, sessionId } = {}) {
  if (sessionId != null) {
    return loadSessionById(Number(sessionId));
  }
  if (code) {
    const normalizedCode = String(code).trim().toUpperCase();
    const session = await CastSession.findOne({
      where: { code: normalizedCode, status: "active" },
    });
    if (!session) {
      throw new CastServiceError(404, "not_found", "CAST session not found.");
    }
    return session;
  }
  throw new CastServiceError(400, "invalid_body", "code or sessionId is required.");
}

/**
 * Wraps a mutating socket event: loads the socket's current session (set by
 * `session:join`), re-checks active membership, runs `mutate`, then
 * broadcasts the resulting state (and, if provided, an activity entry) to
 * the room before acking. Every `queue:*`/`player:*` handler below is a thin
 * call into this.
 *
 * @param {import('socket.io').Socket} socket The event's socket.
 * @param {Function|undefined} ack Socket.IO ack callback, if the client provided one.
 * @param {(session: import('sequelize').Model) => Promise<unknown>} mutate Runs the actual queue-service mutation.
 * @param {{type: string, text: (name: string, result: unknown) => string}} [activity] Activity feed entry to broadcast on success; `text` also receives whatever `mutate` resolved to, for entries that need to mention it.
 * @returns {Promise<void>} Resolves once the ack has been sent.
 */
async function withSessionAction(socket, ack, mutate, activity) {
  try {
    const sessionId = socket.data.sessionId;
    if (sessionId == null) {
      throw new CastServiceError(400, "invalid_body", "Join a session first.");
    }
    const session = await loadSessionById(sessionId);
    const membership = await loadActiveMembership(session.id, socket.data.user.id);
    if (!membership) {
      throw new CastServiceError(403, "forbidden", "You are not a member of this CAST session.");
    }

    const result = await mutate(session);

    await broadcastState(session.id);
    if (activity) {
      const name = displayNameFor(socket.data.user);
      broadcastActivity(session.id, {
        type: activity.type,
        actorName: name,
        text: activity.text(name, result),
      });
    }
    ack?.({ ok: true });
  } catch (err) {
    ack?.({ ok: false, error: errorPayload(err) });
  }
}

/**
 * Runs one playback-clock tick: for every session with a live connection
 * (i.e. present in `presenceBySession`) that's currently playing, broadcasts
 * `player:tick` with the freshly-computed effective position, and every 5th
 * tick also persists that position to CAST_SESSIONS so a restart doesn't
 * lose more than a few seconds of progress. Every
 * {@link INACTIVITY_SWEEP_INTERVAL_TICKS}th tick, also runs
 * {@link sweepInactiveSessions} - which covers sessions with no live
 * connection at all, unlike the rest of this function.
 *
 * @returns {Promise<void>} Resolves once every live session's tick (and, on sweep ticks, the inactivity sweep) has been processed.
 */
async function runTick() {
  tickCount += 1;
  const persistThisTick = tickCount % 5 === 0;

  if (tickCount % INACTIVITY_SWEEP_INTERVAL_TICKS === 0) {
    await sweepInactiveSessions();
  }

  for (const sessionId of Array.from(presenceBySession.keys())) {
    let session;
    try {
      session = await loadSessionById(sessionId);
    } catch {
      presenceBySession.delete(sessionId);
      continue;
    }
    if (session.playbackStatus !== "playing") {
      continue;
    }

    // playbackSnapshot stamps the position and the `serverTime` it's true for
    // from one instant, which is what lets a client advance it without
    // double-counting the elapsed time (see queue-service.js).
    const playback = playbackSnapshot(session);
    io.of("/cast").to(roomName(sessionId)).emit("player:tick", playback);

    if (persistThisTick) {
      session.playbackPositionSeconds = playback.positionSeconds;
      session.playbackUpdatedAt = new Date(playback.serverTime);
      await session.save();
    }
  }
}

/**
 * Ends every session that's gone 8+ hours without a member-driven action -
 * regardless of whether anyone is still connected to it - and broadcasts
 * `session:ended` for each one so any live viewers are notified and dropped
 * from the room the same way a manual end works.
 *
 * @returns {Promise<void>} Resolves once every stale session has been ended and broadcast.
 */
async function sweepInactiveSessions() {
  let endedIds;
  try {
    endedIds = await endInactiveSessions();
  } catch (err) {
    logger.error({ err }, "CAST inactivity sweep failed");
    return;
  }
  for (const sessionId of endedIds) {
    notifySessionEnded(sessionId);
  }
}

/**
 * Attaches the CAST Socket.IO server to `httpServer` under the `/cast`
 * namespace. Idempotent - a second call returns the existing server rather
 * than attaching twice. Must only be called from `index.js`'s `start()`,
 * never from `createApp()`.
 *
 * @param {import('node:http').Server} httpServer The HTTP server to attach to.
 * @returns {import('socket.io').Server} The attached Socket.IO server.
 */
export function attachCastRealtime(httpServer) {
  if (io) {
    return io;
  }

  io = new Server(httpServer, { cors: createCorsOptions() });
  const castNamespace = io.of("/cast");
  const sessionMiddleware = createSessionMiddleware();

  // Socket.IO handshakes bypass Express entirely, so the session cookie has
  // to be parsed by hand here. express-session's signature expects a
  // response object to hook `res.end` for saving a *modified* session -
  // nothing in this handshake modifies the session, so a minimal stub
  // (fresh per call, since express-session may attach per-request state to
  // it) is enough to satisfy it without a real Express response.
  castNamespace.use((socket, next) => {
    const fakeRes = {
      getHeader() {},
      setHeader() {},
      end() {},
      writeHead() {},
      on() {},
    };
    sessionMiddleware(socket.request, fakeRes, async (err) => {
      if (err) {
        next(err);
        return;
      }
      try {
        const auth = await getAuthContext(socket.request);
        if (!auth) {
          next(new Error("unauthorized"));
          return;
        }
        socket.data.user = auth.user;
        socket.data.role = auth.role;
        next();
      } catch (authErr) {
        next(authErr);
      }
    });
  });

  castNamespace.on("connection", (socket) => {
    // Clock handshake. Deliberately session-independent (no membership check,
    // not routed through withSessionAction) - it mutates nothing and answers
    // before a join, so a client can have an offset estimate ready by the time
    // the first `player:tick` lands. `clientSent` is echoed back untouched so
    // the client can measure the round trip against its own clock and derive
    // `offset = serverTime + rtt / 2 - now`; without it every client folds its
    // own wall-clock skew straight into the seek target.
    socket.on("time:sync", (payload, ack) => {
      const clientSent = Number(payload?.clientSent);
      ack?.({
        clientSent: Number.isFinite(clientSent) ? clientSent : null,
        serverTime: Date.now(),
      });
    });

    socket.on("session:join", async (payload, ack) => {
      try {
        const session = await resolveJoinTarget(payload);
        const membership = await loadActiveMembership(session.id, socket.data.user.id);
        if (!membership) {
          throw new CastServiceError(
            403,
            "forbidden",
            "You are not a member of this CAST session.",
          );
        }

        if (socket.data.sessionId != null && socket.data.sessionId !== session.id) {
          const previousSessionId = socket.data.sessionId;
          await socket.leave(roomName(previousSessionId));
          removePresence(previousSessionId, socket.data.user.id, socket.id);
          broadcastPresence(previousSessionId);
        }

        socket.data.sessionId = session.id;
        await socket.join(roomName(session.id));
        addPresence(session.id, socket.data.user.id, socket.id);

        // Broadcast (not just emit to the joining socket) - a join changes
        // the durable `members` list for everyone already in the room, not
        // just presence/activity, so every connected client needs a fresh
        // snapshot, not only the one that just joined.
        await broadcastState(session.id);
        broadcastPresence(session.id);
        const name = displayNameFor(socket.data.user);
        broadcastActivity(session.id, { type: "joined", actorName: name, text: `${name} joined` });
        ack?.({ ok: true });
      } catch (err) {
        ack?.({ ok: false, error: errorPayload(err) });
      }
    });

    socket.on("queue:add", (payload, ack) =>
      withSessionAction(
        socket,
        ack,
        (session) =>
          addQueueItem({
            session,
            user: socket.data.user,
            role: socket.data.role,
            videoIdentifier: String(payload?.videoId ?? ""),
          }),
        { type: "queue_add", text: (name) => `${name} added a video to the queue` },
      ),
    );

    socket.on("queue:add-playlist", (payload, ack) =>
      withSessionAction(
        socket,
        ack,
        (session) =>
          addPlaylistToQueue({
            session,
            user: socket.data.user,
            role: socket.data.role,
            playlistId: Number(payload?.playlistId),
          }),
        {
          type: "queue_add",
          // Says how many actually landed, which can be fewer than the playlist
          // holds - videos the adder can't see are skipped.
          text: (name, result) => {
            const count = result?.addedCount ?? 0;
            return `${name} added ${count} ${count === 1 ? "video" : "videos"} from a playlist`;
          },
        },
      ),
    );

    socket.on("queue:remove", (payload, ack) =>
      withSessionAction(socket, ack, (session) =>
        removeQueueItem({ session, queueItemId: Number(payload?.queueItemId) }),
      ),
    );

    socket.on("queue:move", (payload, ack) =>
      withSessionAction(socket, ack, (session) =>
        reorderQueueItem({
          session,
          queueItemId: Number(payload?.queueItemId),
          toIndex: Number(payload?.toIndex),
        }),
      ),
    );

    socket.on("player:play", (_payload, ack) =>
      withSessionAction(socket, ack, (session) => controlPlayback({ session, action: "play" })),
    );

    socket.on("player:pause", (_payload, ack) =>
      withSessionAction(socket, ack, (session) => controlPlayback({ session, action: "pause" })),
    );

    socket.on("player:seek", (payload, ack) =>
      withSessionAction(socket, ack, (session) =>
        controlPlayback({ session, action: "seek", seconds: Number(payload?.seconds) }),
      ),
    );

    socket.on("player:skip", (_payload, ack) =>
      withSessionAction(
        socket,
        ack,
        (session) => controlPlayback({ session, action: "skip" }),
        { type: "skip", text: (name) => `${name} skipped the video` },
      ),
    );

    socket.on("player:previous", (_payload, ack) =>
      withSessionAction(socket, ack, (session) => controlPlayback({ session, action: "previous" })),
    );

    socket.on("player:ended", (_payload, ack) =>
      withSessionAction(socket, ack, (session) => advanceOnPlaybackEnd({ session })),
    );

    socket.on("player:error", (_payload, ack) =>
      withSessionAction(
        socket,
        ack,
        (session) => advanceOnPlaybackEnd({ session }),
        { type: "playback_error", text: (name) => `${name}'s player hit an error, skipping` },
      ),
    );

    socket.on("react", (payload) => {
      const sessionId = socket.data.sessionId;
      if (sessionId == null) return;
      const emoji = payload?.emoji;
      // Validated rather than truncated: this is broadcast to every member's
      // screen, so arbitrary text must not get through - and the old
      // slice(0, 8) corrupted legitimate emoji (👨‍👩‍👧‍👦 is 11 code units).
      if (!isReactionEmoji(emoji)) return;
      io.of("/cast")
        .to(roomName(sessionId))
        .emit("react", { emoji, name: displayNameFor(socket.data.user) });
      // Fire-and-forget: recordEmojiUse swallows its own failures, so a
      // counter write can never hold up or break the broadcast above.
      recordEmojiUse(emoji);
    });

    socket.on("disconnect", () => {
      const sessionId = socket.data.sessionId;
      if (sessionId == null) return;
      removePresence(sessionId, socket.data.user.id, socket.id);
      broadcastPresence(sessionId);
    });
  });

  tickInterval = setInterval(() => {
    runTick().catch((err) => logger.error({ err }, "CAST playback tick failed"));
  }, 1000);
  tickInterval.unref?.();

  return io;
}

/**
 * Re-broadcasts a session's full state to its room. Called by routes/cast.js
 * after any REST mutation (queue add/remove/move) so already-connected
 * members see the change immediately, without duplicating the mutation
 * logic itself (that lives once in queue-service.js).
 *
 * @param {number} sessionId CAST_SESSIONS id.
 * @returns {Promise<void>} Resolves once broadcast (a no-op if realtime isn't attached).
 */
export async function notifySessionChanged(sessionId) {
  if (!io) return;
  await broadcastState(sessionId);
}

/**
 * Broadcasts an activity feed entry to a session's room. A no-op if realtime
 * isn't attached (e.g. under `supertest(createApp())` in tests).
 *
 * @param {number} sessionId CAST_SESSIONS id.
 * @param {{type: string, actorName: string, text: string}} entry Activity entry.
 * @returns {void}
 */
export function notifyActivity(sessionId, entry) {
  if (!io) return;
  broadcastActivity(sessionId, entry);
}

/**
 * Forcibly disconnects a kicked member's live socket(s) from a session:
 * emits `session:kicked` to warn them, then disconnects each socket
 * (Socket.IO's own `disconnect` handler cleans up presence and rebroadcasts
 * it to the rest of the room). Called by `DELETE /cast/:id/members/:userId`
 * after the kick has already been persisted. A no-op if realtime isn't
 * attached, or if the user has no live socket in this session right now.
 *
 * @param {number} sessionId CAST_SESSIONS id.
 * @param {number} userId The kicked user's id.
 * @returns {void}
 */
export function disconnectMember(sessionId, userId) {
  if (!io) return;
  const socketIds = presenceBySession.get(sessionId)?.get(userId);
  if (!socketIds) return;

  const namespace = io.of("/cast");
  for (const socketId of Array.from(socketIds)) {
    const socket = namespace.sockets.get(socketId);
    if (!socket) continue;
    socket.emit("session:kicked", {});
    socket.leave(roomName(sessionId));
    socket.disconnect(true);
  }
}

/**
 * Broadcasts `session:ended` to a session's room and clears it from presence
 * tracking (and, transitively, the tick loop). Sockets stay connected to the
 * namespace - they just leave the room - since ending a session shouldn't
 * force a member's browser tab to drop its connection outright. Called by
 * `POST /cast/:id/end` after the end has already been persisted. A no-op if
 * realtime isn't attached.
 *
 * @param {number} sessionId CAST_SESSIONS id.
 * @returns {void}
 */
export function notifySessionEnded(sessionId) {
  if (!io) return;
  const namespace = io.of("/cast");
  namespace.to(roomName(sessionId)).emit("session:ended", {});

  const room = namespace.adapter.rooms.get(roomName(sessionId));
  if (room) {
    for (const socketId of Array.from(room)) {
      namespace.sockets.get(socketId)?.leave(roomName(sessionId));
    }
  }
  presenceBySession.delete(sessionId);
}
