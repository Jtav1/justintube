import { Op } from "sequelize";
import {
  filterViewablePlaylistItems,
  loadAccessGrant as loadPlaylistAccessGrant,
} from "../../routes/playlists.js";
import {
  loadAccessGrant as loadVideoAccessGrant,
  loadRenditions,
  loadUploadWithMetadataByIdentifier,
  serializeVideo,
} from "../../routes/videos.js";
import {
  CastQueueItem,
  CastSession,
  CastSessionMember,
  OriginalUpload,
  PlaylistItem,
  User,
  UserPlaylist,
  VideoMetadata,
  VideoThumbnail,
} from "../models/index.js";
import { canViewPlaylist } from "../playlist-access.js";
import { canViewVideo } from "../video-access.js";
import { generateUniqueCastCode } from "./codes.js";
import { CastServiceError } from "./errors.js";

/**
 * lib/cast/queue-service.js is the single mutation path for CAST sessions:
 * every REST route handler (routes/cast.js) and every Socket.IO event
 * handler (lib/cast/realtime.js) calls into these functions rather than
 * touching the CAST_* models directly, so business logic and authorization
 * live in exactly one place regardless of which transport a client used.
 * Functions here take plain data (never `req`/`res`, never the live socket
 * server) and either return the caller's updated {@link loadSessionSnapshot}
 * result or throw a {@link CastServiceError} that the caller maps to an HTTP
 * status / socket error payload.
 *
 * Reuses playlist/video visibility logic that already exists for the
 * regular playlist and video routes (`filterViewablePlaylistItems`,
 * `loadUploadWithMetadataByIdentifier`, `loadAccessGrant`, `canViewPlaylist`,
 * `canViewVideo`) rather than re-implementing it, so a CAST queue can never
 * surface a video a member couldn't otherwise see.
 */

/**
 * Throws if the session has already ended. Called at the top of every
 * mutating operation except `endSession` itself and `leaveSession` (leaving
 * a session that just ended is harmless and should not error).
 *
 * @param {import('sequelize').Model} session CAST_SESSIONS row.
 * @returns {void}
 * @throws {CastServiceError} 409 "session_ended" if the session isn't active.
 */
function assertSessionActive(session) {
  if (session.status !== "active") {
    throw new CastServiceError(409, "session_ended", "This CAST session has ended.");
  }
}

/**
 * How long a session may go without a member-driven action before the
 * inactivity sweep ({@link endInactiveSessions}) ends it.
 *
 * @type {number}
 */
const INACTIVITY_TIMEOUT_MS = 8 * 60 * 60 * 1000;

/**
 * Stamps `lastActivityAt` and persists it. Called after any member-driven
 * mutation that doesn't already save the session row for its own reasons
 * (queue changes, join, kick, rename) - playback-control actions and
 * playback auto-advance set the field directly instead, since they already
 * save `session` themselves.
 *
 * @param {import('sequelize').Model} session CAST_SESSIONS row.
 * @returns {Promise<void>} Resolves once saved.
 */
async function touchActivity(session) {
  session.lastActivityAt = new Date();
  await session.save();
}

/**
 * Computes a session's current effective playback position: the stored
 * position plus elapsed wall-clock time since it was last updated, while
 * playing. Paused sessions (or sessions that have never started playing)
 * return the stored position unchanged. This is the server-authoritative
 * clock every connected member's player syncs against.
 *
 * `nowMs` is injectable so a caller can compute the position and stamp the
 * payload it goes out in from the *same* instant - see {@link playbackSnapshot},
 * where a mismatch between the two is exactly what used to make clients
 * double-count the elapsed time.
 *
 * @param {import('sequelize').Model} session CAST_SESSIONS row.
 * @param {number} [nowMs] The instant to evaluate the clock at, as epoch ms.
 * @returns {number} Effective playback position, in seconds.
 */
export function effectivePosition(session, nowMs = Date.now()) {
  if (session.playbackStatus !== "playing" || !session.playbackUpdatedAt) {
    return session.playbackPositionSeconds;
  }
  const elapsedSeconds = (nowMs - new Date(session.playbackUpdatedAt).getTime()) / 1000;
  return session.playbackPositionSeconds + Math.max(0, elapsedSeconds);
}

/**
 * Serializes a session's playback clock for the wire - the single shape both
 * `state:sync`/REST snapshots and the `player:tick` broadcast use.
 *
 * The contract clients rely on: `positionSeconds` is the effective position
 * **as of `serverTime`**, so a client advances it from `serverTime` (never from
 * `updatedAt`, which is the older "when a control action last moved the clock"
 * timestamp kept here only for change detection). Emitting an
 * already-advanced position next to the stale `updatedAt` is what made every
 * client's sync target run at 2x real time between persists.
 *
 * @param {import('sequelize').Model} session CAST_SESSIONS row.
 * @returns {{status: string, positionSeconds: number, updatedAt: Date|null, serverTime: string}} Public playback payload.
 */
export function playbackSnapshot(session) {
  const nowMs = Date.now();
  return {
    status: session.playbackStatus,
    positionSeconds: effectivePosition(session, nowMs),
    updatedAt: session.playbackUpdatedAt,
    serverTime: new Date(nowMs).toISOString(),
  };
}

/**
 * Serializes a CAST_QUEUE_ITEMS row (with `OriginalUpload.VideoMetadata`
 * preloaded) into the public queue-item shape. `renditions` is only passed
 * for the `nowPlaying` item — that's the one shape actually driving a
 * `<video>` element (see VideoPlayer.jsx's `renditions`/`streamUrl`
 * handling), so queue/history rail entries (rendered as plain VideoCards)
 * skip the extra `loadRenditions` query.
 *
 * @private
 * @param {import('sequelize').Model} row CAST_QUEUE_ITEMS row.
 * @param {object} [options]
 * @param {object[]} [options.renditions] Streamable renditions, for the now-playing item only.
 * @returns {object} Public queue-item payload.
 */
function serializeQueueItem(row, options = {}) {
  return {
    id: row.id,
    status: row.status,
    position: row.position,
    addedByUserId: row.addedByUserId,
    addedAt: row.addedAt,
    playedAt: row.playedAt,
    video: serializeVideo(row.OriginalUpload, row.OriginalUpload.VideoMetadata, {
      renditions: options.renditions,
    }),
  };
}

/**
 * Serializes a CAST_SESSION_MEMBERS row (with `User` preloaded) into the
 * public member shape.
 *
 * @param {import('sequelize').Model} row CAST_SESSION_MEMBERS row.
 * @returns {object} Public member payload.
 */
export function serializeMember(row) {
  return {
    userId: row.userId,
    username: row.User?.username ?? null,
    displayName: row.User?.displayName ?? null,
    avatarFilename: row.User?.avatarFilename ?? null,
    role: row.role,
    status: row.status,
    joinedAt: row.joinedAt,
  };
}

/**
 * Include clause shared by every query that loads CAST_QUEUE_ITEMS rows for
 * display (queue, history, nowPlaying) — preloads the same
 * OriginalUpload → VideoMetadata/VideoThumbnail/User shape `serializeVideo`
 * expects, mirroring the include used by `GET /playlists/:id`.
 *
 * @private
 * @type {object[]}
 */
const QUEUE_ITEM_VIDEO_INCLUDE = [
  {
    model: OriginalUpload,
    required: true,
    include: [
      { model: VideoMetadata, as: "VideoMetadata", required: true },
      { model: VideoThumbnail, required: false },
      { model: User, required: false },
    ],
  },
];

/**
 * Builds the full session snapshot shared by `getCastSpace`, `getCastDisplay`,
 * and the socket `state:sync` event — the single serializer so REST and
 * realtime payloads can never drift apart.
 *
 * @param {import('sequelize').Model} session CAST_SESSIONS row.
 * @returns {Promise<object>} `{session, playback, nowPlaying, queue, history, members}`.
 */
export async function loadSessionSnapshot(session) {
  const [activeRows, historyRows, memberRows] = await Promise.all([
    CastQueueItem.findAll({
      where: { castSessionId: session.id, status: { [Op.in]: ["queued", "playing"] } },
      include: QUEUE_ITEM_VIDEO_INCLUDE,
      order: [
        ["status", "ASC"],
        ["position", "ASC"],
        ["addedAt", "ASC"],
      ],
    }),
    CastQueueItem.findAll({
      where: { castSessionId: session.id, status: { [Op.in]: ["played", "skipped"] } },
      include: QUEUE_ITEM_VIDEO_INCLUDE,
      order: [["playedAt", "DESC"]],
      limit: 10,
    }),
    CastSessionMember.findAll({
      where: { castSessionId: session.id, status: "active" },
      include: [{ model: User, required: true }],
      order: [["joinedAt", "ASC"]],
    }),
  ]);

  const nowPlayingRow = activeRows.find((row) => row.status === "playing") ?? null;
  const queuedRows = activeRows.filter((row) => row.status === "queued");
  const nowPlayingRenditions = nowPlayingRow
    ? await loadRenditions(nowPlayingRow.OriginalUpload)
    : null;

  return {
    session: {
      id: session.id,
      code: session.code,
      status: session.status,
      title: session.title,
      ownerUserId: session.ownerUserId,
      sourcePlaylistId: session.sourcePlaylistId,
      autoAdvanceEnabled: session.autoAdvanceEnabled,
      createdAt: session.createdAt,
    },
    playback: playbackSnapshot(session),
    nowPlaying: nowPlayingRow
      ? serializeQueueItem(nowPlayingRow, { renditions: nowPlayingRenditions })
      : null,
    queue: queuedRows.map((row) => serializeQueueItem(row)),
    history: historyRows.map((row) => serializeQueueItem(row)),
    members: memberRows.map(serializeMember),
  };
}

/**
 * Loads a CAST_SESSIONS row by id, 404ing (as a thrown error) if missing.
 *
 * @param {number} id CAST_SESSIONS id.
 * @returns {Promise<import('sequelize').Model>} The session row.
 * @throws {CastServiceError} 404 "not_found" if no such session exists.
 */
export async function loadSessionById(id) {
  const session = await CastSession.findByPk(id);
  if (!session) {
    throw new CastServiceError(404, "not_found", "CAST session not found.");
  }
  return session;
}

/**
 * Loads a user's active membership row for a session, if any. Used to gate
 * "must be a member" routes/events — the owner is also a member (with
 * `role: "owner"`), so this single check covers both.
 *
 * @param {number} castSessionId CAST_SESSIONS id.
 * @param {number} userId Authenticated user id.
 * @returns {Promise<import('sequelize').Model|null>} The membership row, or null.
 */
export async function loadActiveMembership(castSessionId, userId) {
  return CastSessionMember.findOne({
    where: { castSessionId, userId, status: "active" },
  });
}

/**
 * Loads a playlist the caller is allowed to see, 404ing otherwise. Deliberately
 * indistinguishable from "no such playlist" so a private playlist's existence
 * isn't leaked by the error.
 *
 * @private
 * @param {object} params
 * @param {number} params.playlistId USER_PLAYLISTS id.
 * @param {import('sequelize').Model} params.user Authenticated user.
 * @param {import('sequelize').Model} params.role The user's role row.
 * @returns {Promise<import('sequelize').Model>} The playlist row.
 * @throws {CastServiceError} 404 "not_found" if missing or not viewable.
 */
async function loadViewablePlaylist({ playlistId, user, role }) {
  const playlist = await UserPlaylist.findByPk(playlistId);
  if (!playlist) {
    throw new CastServiceError(404, "not_found", "Playlist not found.");
  }
  const grant = await loadPlaylistAccessGrant(playlist.id, user.id);
  if (!canViewPlaylist(user, role, playlist, Boolean(grant))) {
    throw new CastServiceError(404, "not_found", "Playlist not found.");
  }
  return playlist;
}

/**
 * Expands a playlist into the ordered upload ids the caller may actually watch.
 *
 * Being able to see the playlist is not the same as being able to see every
 * video in it, so `filterViewablePlaylistItems` runs per item as well - it drops
 * hidden videos, private ones the caller has no claim on, and anything the
 * caller has hidden for themselves. Ordering matches `GET /playlists/:id`.
 *
 * Shared by `createSession` (seeding a new session) and `addPlaylistToQueue`
 * (appending to a running one) so the two can't disagree about either.
 *
 * @private
 * @param {object} params
 * @param {import('sequelize').Model} params.playlist The playlist row.
 * @param {import('sequelize').Model} params.user Authenticated user.
 * @param {import('sequelize').Model} params.role The user's role row.
 * @returns {Promise<number[]>} ORIGINAL_UPLOADS ids, in playlist order.
 */
async function loadViewablePlaylistUploadIds({ playlist, user, role }) {
  const items = await PlaylistItem.findAll({
    where: { playlistId: playlist.id },
    include: [
      {
        model: OriginalUpload,
        required: true,
        include: [
          { model: VideoMetadata, as: "VideoMetadata", required: true },
          { model: VideoThumbnail, required: false },
          { model: User, required: false },
        ],
      },
    ],
    order: [
      ["position", "ASC"],
      ["addedAt", "DESC"],
    ],
  });
  const viewableItems = await filterViewablePlaylistItems(items, user, role);
  return viewableItems.map((item) => item.OriginalUpload.id);
}

/**
 * Promotes the next `"queued"` row (lowest `position`) to `"playing"` if no
 * row is currently playing, resetting the session's playback clock to 0 and
 * "playing". A no-op if something is already playing or the queue is empty.
 * Shared by `addQueueItem`, `removeQueueItem` (when the removed item was the
 * one playing), `controlPlayback`'s skip handling, and the socket
 * `player:ended`/`player:error` auto-advance handlers.
 *
 * @param {import('sequelize').Model} session CAST_SESSIONS row.
 * @returns {Promise<void>} Resolves once promotion (or the no-op) completes.
 */
export async function promoteNextQueuedItemIfIdle(session) {
  const alreadyPlaying = await CastQueueItem.findOne({
    where: { castSessionId: session.id, status: "playing" },
  });
  if (alreadyPlaying) {
    return;
  }

  const next = await CastQueueItem.findOne({
    where: { castSessionId: session.id, status: "queued" },
    order: [
      ["position", "ASC"],
      ["addedAt", "ASC"],
    ],
  });
  if (!next) {
    return;
  }

  next.status = "playing";
  next.playedAt = new Date();
  await next.save();

  session.playbackStatus = "playing";
  session.playbackPositionSeconds = 0;
  session.playbackUpdatedAt = new Date();
  await session.save();
}

/**
 * Transitions the currently-playing item to `"played"` and promotes the next
 * queued item, if any. Called from the socket layer when a member's own
 * player reports the video ended naturally (`player:ended`) or hit an
 * unrecoverable playback error (`player:error`) — either way the queue
 * should auto-advance rather than stall. There's no distinct "errored"
 * queue-item status; both outcomes just mean "this item's turn is over."
 *
 * `queueItemId` identifies the item the reporter finished, so duplicate
 * reports from other members' players (which all end at once) are no-ops
 * instead of double-advancing the queue. Omitted falls back to unconditional
 * behaviour for older clients.
 *
 * The finished item still moves to `"played"` regardless of
 * `session.autoAdvanceEnabled` - only the *promotion* of the next queued item
 * is gated, so turning auto-advance off holds the queue with nothing
 * `"playing"` (nowPlaying null, the remaining items still queued) until
 * someone calls `skip`/`controlPlayback` or auto-advance is turned back on.
 *
 * @param {object} params
 * @param {import('sequelize').Model} params.session CAST_SESSIONS row.
 * @param {number} [params.queueItemId] CAST_QUEUE_ITEMS id the reporter finished; ignored when absent.
 * @returns {Promise<object>} The updated session's {@link loadSessionSnapshot} result.
 */
export async function advanceOnPlaybackEnd({ session, queueItemId }) {
  const current = await CastQueueItem.findOne({
    where: { castSessionId: session.id, status: "playing" },
  });
  if (queueItemId != null && Number.isFinite(queueItemId) && current?.id !== queueItemId) {
    return loadSessionSnapshot(session);
  }
  if (current) {
    // Conditional UPDATE, not current.save(): concurrent reporters can race
    // reading this row, so only the update that actually flips it wins.
    const [affected] = await CastQueueItem.update(
      { status: "played" },
      { where: { id: current.id, status: "playing" } },
    );
    if (affected === 0) {
      return loadSessionSnapshot(session);
    }
  }

  session.playbackStatus = "paused";
  session.playbackPositionSeconds = 0;
  session.playbackUpdatedAt = new Date();
  session.lastActivityAt = new Date();
  await session.save();

  if (session.autoAdvanceEnabled) {
    await promoteNextQueuedItemIfIdle(session);
  }
  return loadSessionSnapshot(session);
}

/**
 * Creates a new CAST session, seeding its queue from a playlist (a filtered
 * *copy* — the source USER_PLAYLISTS/PLAYLIST_ITEMS rows are never written
 * to), a single video, or nothing. The creating user becomes the session's
 * owner (both `CAST_SESSIONS.ownerUserId` and a `role: "owner"`
 * CAST_SESSION_MEMBERS row).
 *
 * @param {object} params
 * @param {import('sequelize').Model} params.user Authenticated user (becomes the owner).
 * @param {import('sequelize').Model|null|undefined} params.role Authenticated role.
 * @param {"playlist"|"video"|"empty"} params.sourceType What to seed the queue from.
 * @param {number} [params.playlistId] USER_PLAYLISTS id, required when `sourceType === "playlist"`.
 * @param {string} [params.videoIdentifier] Video pk or public videoId, required when `sourceType === "video"`.
 * @returns {Promise<object>} The new session's {@link loadSessionSnapshot} result.
 * @throws {CastServiceError} 400 for invalid input, 404 if the playlist/video isn't viewable.
 */
export async function createSession({ user, role, sourceType, playlistId, videoIdentifier }) {
  if (!["playlist", "video", "empty"].includes(sourceType)) {
    throw new CastServiceError(
      400,
      "invalid_body",
      'sourceType must be "playlist", "video", or "empty".',
    );
  }

  let sourcePlaylistId = null;
  let seedUploadIds = [];

  if (sourceType === "playlist") {
    if (playlistId == null) {
      throw new CastServiceError(
        400,
        "invalid_body",
        'playlistId is required when sourceType is "playlist".',
      );
    }
    const playlist = await loadViewablePlaylist({ playlistId, user, role });
    seedUploadIds = await loadViewablePlaylistUploadIds({ playlist, user, role });
    sourcePlaylistId = playlist.id;
  } else if (sourceType === "video") {
    if (!videoIdentifier) {
      throw new CastServiceError(
        400,
        "invalid_body",
        'videoId is required when sourceType is "video".',
      );
    }
    const loaded = await loadUploadWithMetadataByIdentifier(videoIdentifier);
    if (!loaded) {
      throw new CastServiceError(404, "not_found", "Video not found.");
    }
    const grant = await loadVideoAccessGrant(loaded.upload.id, user.id);
    if (!canViewVideo(user, role, loaded.upload, loaded.metadata, Boolean(grant))) {
      throw new CastServiceError(404, "not_found", "Video not found.");
    }
    seedUploadIds = [loaded.upload.id];
  }

  const code = await generateUniqueCastCode();
  const ownerName = user.displayName || user.username || "Someone";
  const session = await CastSession.create({
    code,
    status: "active",
    ownerUserId: user.id,
    sourcePlaylistId,
    title: `${ownerName}'s Watch Party`,
    playbackStatus: "paused",
    playbackPositionSeconds: 0,
    lastActivityAt: new Date(),
  });

  await CastSessionMember.create({
    castSessionId: session.id,
    userId: user.id,
    role: "owner",
    status: "active",
  });

  if (seedUploadIds.length > 0) {
    const records = seedUploadIds.map((originalUploadId, index) => ({
      castSessionId: session.id,
      originalUploadId,
      addedByUserId: user.id,
      status: index === 0 ? "playing" : "queued",
      position: index === 0 ? null : index,
      playedAt: index === 0 ? new Date() : null,
    }));
    await CastQueueItem.bulkCreate(records);
    session.playbackStatus = "playing";
    session.playbackPositionSeconds = 0;
    session.playbackUpdatedAt = new Date();
    await session.save();
  }

  // A freshly `.create()`d instance doesn't resolve the `createdAt`/`updatedAt`
  // CURRENT_TIMESTAMP literal defaults into real Date values on SQLite - only
  // a query against the DB (which every other snapshot caller already goes
  // through via loadSessionById's findByPk) does. Without this, the create
  // response's `session.createdAt` would serialize as a raw Sequelize literal
  // object instead of a timestamp.
  await session.reload();
  return loadSessionSnapshot(session);
}

/**
 * Joins (or rejoins) a session by its code. A previously-`"kicked"` member is
 * permanently rejected; a `"left"` member's existing row is reactivated
 * rather than a new row inserted (the `(castSessionId, userId)` unique index
 * guarantees at most one membership row per user per session).
 *
 * @param {object} params
 * @param {string} params.code Join code, case-insensitive.
 * @param {import('sequelize').Model} params.user Authenticated user joining.
 * @returns {Promise<object>} The joined session's {@link loadSessionSnapshot} result.
 * @throws {CastServiceError} 400 for a missing code, 404 for an unknown/inactive code,
 *   403 "kicked_from_session" if this user was previously kicked.
 */
export async function joinSessionByCode({ code, user }) {
  const normalizedCode = String(code ?? "").trim().toUpperCase();
  if (!normalizedCode) {
    throw new CastServiceError(400, "invalid_body", "code is required.");
  }

  const session = await CastSession.findOne({
    where: { code: normalizedCode, status: "active" },
  });
  if (!session) {
    throw new CastServiceError(404, "not_found", "CAST session not found.");
  }

  const existing = await CastSessionMember.findOne({
    where: { castSessionId: session.id, userId: user.id },
  });
  if (existing?.status === "kicked") {
    throw new CastServiceError(
      403,
      "kicked_from_session",
      "You were removed from this session.",
    );
  }

  if (existing) {
    existing.status = "active";
    existing.leftAt = null;
    await existing.save();
  } else {
    await CastSessionMember.create({
      castSessionId: session.id,
      userId: user.id,
      role: "member",
      status: "active",
    });
  }

  await touchActivity(session);
  return loadSessionSnapshot(session);
}

/**
 * Adds a video to the end of a session's queue. Subject to the same
 * per-video visibility check as adding a video anywhere else in the app —
 * membership in the session does not itself grant visibility into a private
 * video the member couldn't otherwise see.
 *
 * @param {object} params
 * @param {import('sequelize').Model} params.session CAST_SESSIONS row.
 * @param {import('sequelize').Model} params.user Authenticated user adding the item.
 * @param {import('sequelize').Model|null|undefined} params.role Authenticated role.
 * @param {string} params.videoIdentifier Video pk or public videoId.
 * @returns {Promise<object>} The updated session's {@link loadSessionSnapshot} result.
 * @throws {CastServiceError} 404 if the video doesn't exist or isn't viewable, 409 if ended.
 */
export async function addQueueItem({ session, user, role, videoIdentifier }) {
  assertSessionActive(session);

  const loaded = await loadUploadWithMetadataByIdentifier(videoIdentifier);
  if (!loaded) {
    throw new CastServiceError(404, "not_found", "Video not found.");
  }
  const grant = await loadVideoAccessGrant(loaded.upload.id, user.id);
  if (!canViewVideo(user, role, loaded.upload, loaded.metadata, Boolean(grant))) {
    throw new CastServiceError(404, "not_found", "Video not found.");
  }

  const maxPosition = await CastQueueItem.max("position", {
    where: { castSessionId: session.id, status: "queued" },
  });
  await CastQueueItem.create({
    castSessionId: session.id,
    originalUploadId: loaded.upload.id,
    addedByUserId: user.id,
    status: "queued",
    position: typeof maxPosition === "number" ? maxPosition + 1 : 0,
  });

  await promoteNextQueuedItemIfIdle(session);
  await touchActivity(session);
  return loadSessionSnapshot(session);
}

/**
 * Appends every video of a playlist the caller may watch to the end of the
 * queue, in playlist order.
 *
 * One `bulkCreate` rather than a loop over {@link addQueueItem}: that would
 * re-run `loadSessionSnapshot` (three queries plus `loadRenditions`) once per
 * video. Videos the caller can't see are skipped rather than failing the whole
 * add, so `addedCount` can be lower than the playlist's length - the caller
 * reports it so nobody is left wondering where the rest went. An empty result
 * is not an error: a playlist of entirely unviewable videos is a legitimate
 * no-op.
 *
 * @param {object} params
 * @param {import('sequelize').Model} params.session CAST_SESSIONS row.
 * @param {import('sequelize').Model} params.user The member adding the playlist.
 * @param {import('sequelize').Model} params.role The user's role row.
 * @param {number} params.playlistId USER_PLAYLISTS id.
 * @returns {Promise<{snapshot: object, addedCount: number, playlistTitle: string}>} The updated snapshot plus how much was added.
 * @throws {CastServiceError} 404 if the playlist isn't viewable, 409 if the session has ended.
 */
export async function addPlaylistToQueue({ session, user, role, playlistId }) {
  assertSessionActive(session);

  const playlist = await loadViewablePlaylist({ playlistId, user, role });
  const uploadIds = await loadViewablePlaylistUploadIds({ playlist, user, role });

  if (uploadIds.length > 0) {
    const maxPosition = await CastQueueItem.max("position", {
      where: { castSessionId: session.id, status: "queued" },
    });
    const basePosition = typeof maxPosition === "number" ? maxPosition + 1 : 0;
    await CastQueueItem.bulkCreate(
      uploadIds.map((originalUploadId, index) => ({
        castSessionId: session.id,
        originalUploadId,
        addedByUserId: user.id,
        status: "queued",
        position: basePosition + index,
      })),
    );
    await promoteNextQueuedItemIfIdle(session);
    await touchActivity(session);
  }

  return {
    snapshot: await loadSessionSnapshot(session),
    addedCount: uploadIds.length,
    playlistTitle: playlist.title,
  };
}

/**
 * Removes (soft-deletes, `status: "removed"`) a queue item. If the removed
 * item was the one currently playing, promotes the next queued item so
 * playback doesn't stall.
 *
 * @param {object} params
 * @param {import('sequelize').Model} params.session CAST_SESSIONS row.
 * @param {number} params.queueItemId CAST_QUEUE_ITEMS id.
 * @returns {Promise<object>} The updated session's {@link loadSessionSnapshot} result.
 * @throws {CastServiceError} 404 if the item doesn't exist (or is already removed), 409 if ended.
 */
export async function removeQueueItem({ session, queueItemId }) {
  assertSessionActive(session);

  const item = await CastQueueItem.findOne({
    where: { id: queueItemId, castSessionId: session.id },
  });
  if (!item || item.status === "removed") {
    throw new CastServiceError(404, "not_found", "Queue item not found.");
  }

  const wasPlaying = item.status === "playing";
  item.status = "removed";
  await item.save();

  if (wasPlaying) {
    await promoteNextQueuedItemIfIdle(session);
  }
  await touchActivity(session);
  return loadSessionSnapshot(session);
}

/**
 * Moves a `"queued"` item to a new position among the other queued items,
 * renumbering `position` (0-based) for every affected row.
 *
 * @param {object} params
 * @param {import('sequelize').Model} params.session CAST_SESSIONS row.
 * @param {number} params.queueItemId CAST_QUEUE_ITEMS id (must be `"queued"`, not `"playing"`).
 * @param {number} params.toIndex Target 0-based index among queued items (clamped to the valid range).
 * @returns {Promise<object>} The updated session's {@link loadSessionSnapshot} result.
 * @throws {CastServiceError} 400 for an invalid `toIndex`, 404 if the item isn't a queued item, 409 if ended.
 */
export async function reorderQueueItem({ session, queueItemId, toIndex }) {
  assertSessionActive(session);

  if (!Number.isInteger(toIndex) || toIndex < 0) {
    throw new CastServiceError(400, "invalid_body", "toIndex must be a non-negative integer.");
  }

  const queued = await CastQueueItem.findAll({
    where: { castSessionId: session.id, status: "queued" },
    order: [
      ["position", "ASC"],
      ["addedAt", "ASC"],
    ],
  });
  const index = queued.findIndex((item) => item.id === Number(queueItemId));
  if (index === -1) {
    throw new CastServiceError(404, "not_found", "Queue item not found.");
  }

  const [moved] = queued.splice(index, 1);
  const clampedIndex = Math.min(toIndex, queued.length);
  queued.splice(clampedIndex, 0, moved);

  for (let i = 0; i < queued.length; i += 1) {
    if (queued[i].position !== i) {
      queued[i].position = i;
      await queued[i].save();
    }
  }

  await touchActivity(session);
  return loadSessionSnapshot(session);
}

/**
 * Moves playback to the previous queue item: the most recently played or
 * skipped item (by `playedAt`) becomes `"playing"` again, and the item that
 * was playing is requeued at the front (`position: 0`, shifting every other
 * queued item back by one). A no-op if there's no history to go back to.
 *
 * @private
 * @param {import('sequelize').Model} session CAST_SESSIONS row.
 * @returns {Promise<void>} Resolves once the swap (or no-op) completes.
 */
async function playPreviousQueueItem(session) {
  const last = await CastQueueItem.findOne({
    where: { castSessionId: session.id, status: { [Op.in]: ["played", "skipped"] } },
    order: [["playedAt", "DESC"]],
  });
  if (!last) {
    return;
  }

  const current = await CastQueueItem.findOne({
    where: { castSessionId: session.id, status: "playing" },
  });
  if (current) {
    const queuedRows = await CastQueueItem.findAll({
      where: { castSessionId: session.id, status: "queued" },
      order: [
        ["position", "ASC"],
        ["addedAt", "ASC"],
      ],
    });
    for (const row of queuedRows) {
      row.position = (row.position ?? 0) + 1;
      await row.save();
    }
    current.status = "queued";
    current.position = 0;
    current.playedAt = null;
    await current.save();
  }

  last.status = "playing";
  last.playedAt = new Date();
  await last.save();

  session.playbackStatus = "playing";
  session.playbackPositionSeconds = 0;
  session.playbackUpdatedAt = new Date();
}

/**
 * Applies a playback-control action, mutating the session's
 * server-authoritative playback clock (and, for skip/previous, the queue's
 * playing item) immediately.
 *
 * @param {object} params
 * @param {import('sequelize').Model} params.session CAST_SESSIONS row.
 * @param {"play"|"pause"|"seek"|"skip"|"previous"} params.action Action to apply.
 * @param {number} [params.seconds] Target position in seconds, required for `"seek"`.
 * @returns {Promise<object>} The updated session's {@link loadSessionSnapshot} result.
 * @throws {CastServiceError} 400 for an unsupported action or invalid `seconds`, 409 if ended.
 */
export async function controlPlayback({ session, action, seconds }) {
  assertSessionActive(session);
  session.lastActivityAt = new Date();

  if (action === "play") {
    session.playbackStatus = "playing";
    session.playbackUpdatedAt = new Date();
    await session.save();
  } else if (action === "pause") {
    session.playbackPositionSeconds = effectivePosition(session);
    session.playbackStatus = "paused";
    session.playbackUpdatedAt = new Date();
    await session.save();
  } else if (action === "seek") {
    const target = Number(seconds);
    if (!Number.isFinite(target) || target < 0) {
      throw new CastServiceError(400, "invalid_body", "seconds must be a non-negative number.");
    }
    session.playbackPositionSeconds = target;
    session.playbackUpdatedAt = new Date();
    await session.save();
  } else if (action === "skip") {
    const current = await CastQueueItem.findOne({
      where: { castSessionId: session.id, status: "playing" },
    });
    if (current) {
      current.status = "skipped";
      await current.save();
    }
    session.playbackPositionSeconds = 0;
    session.playbackStatus = "paused";
    session.playbackUpdatedAt = new Date();
    await session.save();
    await promoteNextQueuedItemIfIdle(session);
  } else if (action === "previous") {
    await playPreviousQueueItem(session);
    await session.save();
  } else {
    throw new CastServiceError(400, "invalid_body", "Unsupported playback action.");
  }

  return loadSessionSnapshot(session);
}

/**
 * Removes a member from a session (owner-only). Kicking is durable — the
 * member's row is marked `"kicked"` rather than deleted, permanently
 * blocking rejoin via `joinSessionByCode`. The realtime layer
 * (`lib/cast/realtime.js`) is responsible for actually disconnecting the
 * kicked user's live socket(s) after this resolves.
 *
 * @param {object} params
 * @param {import('sequelize').Model} params.session CAST_SESSIONS row.
 * @param {import('sequelize').Model} params.actingUser The user requesting the kick.
 * @param {number} params.targetUserId User id to remove.
 * @returns {Promise<object>} The updated session's {@link loadSessionSnapshot} result.
 * @throws {CastServiceError} 403 if the caller isn't the owner, 400 if targeting the owner,
 *   404 if the target isn't an active member, 409 if ended.
 */
export async function kickMember({ session, actingUser, targetUserId }) {
  assertSessionActive(session);

  if (Number(actingUser.id) !== Number(session.ownerUserId)) {
    throw new CastServiceError(403, "forbidden", "Only the session owner can kick members.");
  }
  if (Number(targetUserId) === Number(session.ownerUserId)) {
    throw new CastServiceError(400, "invalid_body", "The session owner cannot be kicked.");
  }

  const member = await CastSessionMember.findOne({
    where: { castSessionId: session.id, userId: targetUserId, status: "active" },
  });
  if (!member) {
    throw new CastServiceError(404, "not_found", "Member not found.");
  }

  member.status = "kicked";
  member.leftAt = new Date();
  await member.save();

  await touchActivity(session);
  return loadSessionSnapshot(session);
}

/**
 * Marks the caller's own membership as `"left"`. Harmless (and allowed) even
 * after the session has ended; a no-op if the caller wasn't an active member.
 * If that was the last active member (which includes the owner - owner is a
 * member like anyone else), the session is auto-ended the same way
 * {@link endSession} would, so an abandoned session doesn't linger forever
 * waiting for someone to come back and end it manually.
 *
 * @param {object} params
 * @param {import('sequelize').Model} params.session CAST_SESSIONS row.
 * @param {import('sequelize').Model} params.user Authenticated user leaving.
 * @returns {Promise<{snapshot: object, ended: boolean}>} The updated session's
 *   {@link loadSessionSnapshot} result, and whether this call auto-ended it.
 */
export async function leaveSession({ session, user }) {
  const member = await CastSessionMember.findOne({
    where: { castSessionId: session.id, userId: user.id, status: "active" },
  });
  if (member) {
    member.status = "left";
    member.leftAt = new Date();
    await member.save();
  }

  let ended = false;
  if (session.status === "active") {
    const remainingActive = await CastSessionMember.count({
      where: { castSessionId: session.id, status: "active" },
    });
    if (remainingActive === 0) {
      session.playbackPositionSeconds = effectivePosition(session);
      session.playbackStatus = "paused";
      session.playbackUpdatedAt = new Date();
      session.status = "ended";
      session.endedAt = new Date();
      await session.save();
      ended = true;
    }
  }

  return { snapshot: await loadSessionSnapshot(session), ended };
}

/**
 * Ends a session (owner or admin): freezes the playback clock, marks the
 * session `"ended"`. The realtime layer is responsible for broadcasting
 * `session:ended` and clearing the room afterward.
 *
 * @param {object} params
 * @param {import('sequelize').Model} params.session CAST_SESSIONS row.
 * @param {import('sequelize').Model} params.actingUser The user requesting the end.
 * @param {{ name?: string }} [params.actingRole] The caller's role, so admins can
 *   end any session from the admin surface. Omitted callers are owner-only.
 * @returns {Promise<object>} The ended session's {@link loadSessionSnapshot} result.
 * @throws {CastServiceError} 403 if the caller is neither owner nor admin, 409 if already ended.
 */
export async function endSession({ session, actingUser, actingRole }) {
  assertSessionActive(session);

  const isOwner = Number(actingUser.id) === Number(session.ownerUserId);
  const isAdmin = actingRole?.name === "admin";
  if (!isOwner && !isAdmin) {
    throw new CastServiceError(
      403,
      "forbidden",
      "Only the session owner or an admin can end the session.",
    );
  }

  session.playbackPositionSeconds = effectivePosition(session);
  session.playbackStatus = "paused";
  session.playbackUpdatedAt = new Date();
  session.status = "ended";
  session.endedAt = new Date();
  await session.save();

  return loadSessionSnapshot(session);
}

/**
 * Ends every active session whose `lastActivityAt` (or `createdAt`, for
 * sessions predating that column) is older than {@link INACTIVITY_TIMEOUT_MS}
 * - regardless of whether members are still present. Called periodically by
 * the realtime layer's sweep interval; safe to call with nobody connected
 * (e.g. in a test) since it only touches the DB. Callers are responsible for
 * broadcasting `session:ended` for each returned id, same as any other end.
 *
 * @returns {Promise<number[]>} Ids of the sessions that were ended.
 */
export async function endInactiveSessions() {
  const cutoff = new Date(Date.now() - INACTIVITY_TIMEOUT_MS);
  const staleSessions = await CastSession.findAll({
    where: {
      status: "active",
      [Op.or]: [
        { lastActivityAt: { [Op.lt]: cutoff } },
        { lastActivityAt: null, createdAt: { [Op.lt]: cutoff } },
      ],
    },
  });

  const endedIds = [];
  for (const session of staleSessions) {
    session.playbackPositionSeconds = effectivePosition(session);
    session.playbackStatus = "paused";
    session.playbackUpdatedAt = new Date();
    session.status = "ended";
    session.endedAt = new Date();
    await session.save();
    endedIds.push(session.id);
  }
  return endedIds;
}

/**
 * Renames a session (owner or admin). The caller is expected to have already
 * validated and trimmed `title`; the realtime layer re-broadcasts the snapshot
 * so connected members see the new name without a refetch.
 *
 * @param {object} params
 * @param {import('sequelize').Model} params.session CAST_SESSIONS row.
 * @param {import('sequelize').Model} params.actingUser The user requesting the rename.
 * @param {{ name?: string }} [params.actingRole] The caller's role, so admins can
 *   rename any session. Omitted callers are owner-only.
 * @param {string} params.title The new title.
 * @returns {Promise<object>} The renamed session's {@link loadSessionSnapshot} result.
 * @throws {CastServiceError} 403 if the caller is neither owner nor admin, 409 if already ended.
 */
export async function renameSession({ session, actingUser, actingRole, title }) {
  assertSessionActive(session);

  const isOwner = Number(actingUser.id) === Number(session.ownerUserId);
  const isAdmin = actingRole?.name === "admin";
  if (!isOwner && !isAdmin) {
    throw new CastServiceError(
      403,
      "forbidden",
      "Only the session owner or an admin can rename the session.",
    );
  }

  session.title = title;
  session.lastActivityAt = new Date();
  await session.save();

  return loadSessionSnapshot(session);
}

/**
 * Sets whether a session auto-advances to the next queued item when the
 * current one finishes (owner or admin) - see {@link advanceOnPlaybackEnd}
 * for what happens while it's off.
 *
 * @param {object} params
 * @param {import('sequelize').Model} params.session CAST_SESSIONS row.
 * @param {import('sequelize').Model} params.actingUser The user requesting the change.
 * @param {{ name?: string }} [params.actingRole] The caller's role, so admins can
 *   change any session. Omitted callers are owner-only.
 * @param {boolean} params.enabled New auto-advance setting.
 * @returns {Promise<object>} The updated session's {@link loadSessionSnapshot} result.
 * @throws {CastServiceError} 403 if the caller is neither owner nor admin, 409 if already ended.
 */
export async function setSessionAutoAdvance({ session, actingUser, actingRole, enabled }) {
  assertSessionActive(session);

  const isOwner = Number(actingUser.id) === Number(session.ownerUserId);
  const isAdmin = actingRole?.name === "admin";
  if (!isOwner && !isAdmin) {
    throw new CastServiceError(
      403,
      "forbidden",
      "Only the session owner or an admin can change auto-advance.",
    );
  }

  session.autoAdvanceEnabled = Boolean(enabled);
  session.lastActivityAt = new Date();
  await session.save();

  return loadSessionSnapshot(session);
}
