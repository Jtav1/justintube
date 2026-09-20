import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "@jest/globals";
import { createServer } from "node:http";
import request from "supertest";
import { io as ioClient } from "socket.io-client";
import { createApp } from "../../index.js";
import { attachCastRealtime } from "../../lib/cast/realtime.js";
import { EmojiReactionUsage, Role } from "../../lib/models/index.js";
import {
  resetTables,
  seedMetadata,
  seedPlaylist,
  seedPlaylistItem,
  seedUpload,
  seedUser,
  seedUserApiKey,
  setupSchema,
} from "../helpers/db.js";

/**
 * Waits for a specific event on a socket.io-client socket, rejecting if it
 * doesn't fire within `timeoutMs`.
 *
 * @param {import('socket.io-client').Socket} socket Client socket.
 * @param {string} event Event name to wait for.
 * @param {number} [timeoutMs] How long to wait before rejecting.
 * @returns {Promise<unknown>} The event's first argument.
 */
function waitForEvent(socket, event, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for "${event}"`)),
      timeoutMs,
    );
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/**
 * Emits a socket.io event with an ack callback, resolving with the ack payload.
 *
 * @param {import('socket.io-client').Socket} socket Client socket.
 * @param {string} event Event name.
 * @param {object} [payload] Event payload.
 * @returns {Promise<{ok: boolean, error: object|undefined}>} The ack payload.
 */
function emitWithAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ack on "${event}"`)),
      4000,
    );
    socket.emit(event, payload, (ack) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

/**
 * Realtime tests for lib/cast/realtime.js: boots a real http.Server with
 * attachCastRealtime wired in (unlike every other test file, which drives
 * createApp() through supertest with no live socket server) and drives it
 * with actual socket.io-client connections. REST mutations in this file go
 * through the same `app`/DB the sockets are attached to, so a REST call's
 * `notifySessionChanged`/`disconnectMember` calls (lib/cast/realtime.js)
 * reach the live sockets exactly as they would in production. Everything
 * that doesn't need a live socket is covered instead by tests/http/cast.test.js.
 */
describe("CAST realtime (Socket.IO /cast namespace)", () => {
  /** @type {import('node:http').Server} */
  let httpServer;
  /** @type {string} */
  let baseUrl;
  /** @type {import('express').Express} */
  let app;
  /** @type {import('socket.io-client').Socket[]} */
  let openSockets;

  beforeAll(async () => {
    await setupSchema();
    app = createApp();
    httpServer = createServer(app);
    attachCastRealtime(httpServer);
    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    openSockets = [];
  });

  afterEach(async () => {
    for (const socket of openSockets) {
      socket.disconnect();
    }
    await resetTables();
  });

  afterAll(async () => {
    await new Promise((resolve) => httpServer.close(resolve));
  });

  /**
   * Seeds a viewer with an API key. Sockets in this file authenticate with
   * `Authorization: Bearer <key>` via `extraHeaders` (Node socket.io-client
   * can set arbitrary headers on the handshake request, unlike a browser
   * WebSocket) rather than a session cookie, since that avoids needing a
   * full cookie-jar login flow just to open a socket.
   *
   * @param {string} rawKey Plaintext API key.
   * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded user.
   */
  async function seedUserWithKey(rawKey) {
    const role = await Role.findOne({ where: { name: "viewer" } });
    const user = await seedUser({ roleId: role?.id ?? null, emailVerified: true });
    await seedUserApiKey(user.id, rawKey);
    return user;
  }

  /**
   * Opens a socket.io-client connection to the `/cast` namespace, tracked
   * for automatic disconnect in `afterEach`.
   *
   * @param {string} rawKey Plaintext API key to authenticate with.
   * @returns {import('socket.io-client').Socket} The connecting client socket.
   */
  function connectSocket(rawKey) {
    const socket = ioClient(`${baseUrl}/cast`, {
      extraHeaders: { Authorization: `Bearer ${rawKey}` },
      transports: ["polling", "websocket"],
      forceNew: true,
    });
    openSockets.push(socket);
    return socket;
  }

  /**
   * Creates an empty CAST session via REST as the given API key's user.
   *
   * @param {string} rawKey Plaintext API key.
   * @returns {Promise<object>} The created session snapshot.
   */
  async function createSession(rawKey) {
    const res = await request(app)
      .post("/api/v1/cast")
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ sourceType: "empty" });
    return res.body;
  }

  test("session:join acks ok and delivers a state:sync snapshot", async () => {
    await seedUserWithKey("rt-key-1");
    const session = await createSession("rt-key-1");
    const socket = connectSocket("rt-key-1");
    await waitForEvent(socket, "connect");

    const statePromise = waitForEvent(socket, "state:sync");
    const ack = await emitWithAck(socket, "session:join", { sessionId: session.session.id });

    expect(ack.ok).toBe(true);
    const state = await statePromise;
    expect(state.session.id).toBe(session.session.id);
  }, 10000);

  test("a queue:add mutation broadcasts state:sync to every connected member", async () => {
    await seedUserWithKey("rt-key-2a");
    const session = await createSession("rt-key-2a");
    await seedUserWithKey("rt-key-2b");
    await request(app)
      .post("/api/v1/cast/join")
      .set("Authorization", "Bearer rt-key-2b")
      .send({ code: session.session.code });

    const ownerSocket = connectSocket("rt-key-2a");
    const memberSocket = connectSocket("rt-key-2b");
    await Promise.all([
      waitForEvent(ownerSocket, "connect"),
      waitForEvent(memberSocket, "connect"),
    ]);
    await emitWithAck(ownerSocket, "session:join", { sessionId: session.session.id });
    await emitWithAck(memberSocket, "session:join", { sessionId: session.session.id });

    const upload = await seedUpload();
    await seedMetadata(upload.id);

    const memberStatePromise = waitForEvent(memberSocket, "state:sync");
    const ack = await emitWithAck(ownerSocket, "queue:add", { videoId: String(upload.id) });
    expect(ack.ok).toBe(true);

    const state = await memberStatePromise;
    expect(state.nowPlaying.video.id).toBe(upload.id);
  }, 10000);

  test("player:play starts a player:tick broadcast reflecting the server clock", async () => {
    await seedUserWithKey("rt-key-3");
    const session = await createSession("rt-key-3");
    const upload = await seedUpload();
    await seedMetadata(upload.id);

    const socket = connectSocket("rt-key-3");
    await waitForEvent(socket, "connect");
    await emitWithAck(socket, "session:join", { sessionId: session.session.id });
    await emitWithAck(socket, "queue:add", { videoId: String(upload.id) });

    const playAck = await emitWithAck(socket, "player:play", {});
    expect(playAck.ok).toBe(true);

    const tick = await waitForEvent(socket, "player:tick", 4000);
    expect(tick.status).toBe("playing");
    expect(typeof tick.positionSeconds).toBe("number");

    // Clients advance positionSeconds from serverTime, so the tick has to say
    // which instant the position belongs to. Without it (or with the older
    // control-action timestamp in its place) every client counts the same
    // elapsed seconds twice and its sync target runs at double speed.
    expect(typeof tick.serverTime).toBe("string");
    const tickAge = Date.now() - new Date(tick.serverTime).getTime();
    expect(Math.abs(tickAge)).toBeLessThan(4000);
  }, 10000);

  test("time:sync acks the caller's stamp alongside the server's clock", async () => {
    await seedUserWithKey("rt-key-clock-1");
    const socket = connectSocket("rt-key-clock-1");
    await waitForEvent(socket, "connect");

    const clientSent = Date.now();
    const ack = await emitWithAck(socket, "time:sync", { clientSent });

    // Echoed back so the client can measure the round trip against its own
    // clock, which is what the offset estimate is built from.
    expect(ack.clientSent).toBe(clientSent);
    expect(typeof ack.serverTime).toBe("number");
    expect(ack.serverTime).toBeGreaterThanOrEqual(clientSent);

    // Deliberately answerable before joining anything - a client wants an offset
    // in hand before its first player:tick arrives.
    expect(socket.connected).toBe(true);
  }, 10000);

  test("player:seek moves the session clock for every member", async () => {
    await seedUserWithKey("rt-key-seek-1");
    const session = await createSession("rt-key-seek-1");
    const upload = await seedUpload();
    await seedMetadata(upload.id);

    const socket = connectSocket("rt-key-seek-1");
    await waitForEvent(socket, "connect");
    await emitWithAck(socket, "session:join", { sessionId: session.session.id });
    await emitWithAck(socket, "queue:add", { videoId: String(upload.id) });

    const statePromise = waitForEvent(socket, "state:sync");
    const ack = await emitWithAck(socket, "player:seek", { seconds: 125.5 });
    expect(ack.ok).toBe(true);

    const state = await statePromise;
    expect(state.playback.positionSeconds).toBeGreaterThanOrEqual(125.5);
    expect(state.playback.positionSeconds).toBeLessThan(127);
  }, 10000);

  test("queue:add-playlist appends the playlist and reports the count in the activity feed", async () => {
    const owner = await seedUserWithKey("rt-key-pl-1");
    const session = await createSession("rt-key-pl-1");
    const playlist = await seedPlaylist({ userId: owner.id, visibility: "private" });
    const uploadA = await seedUpload();
    await seedMetadata(uploadA.id);
    const uploadB = await seedUpload();
    await seedMetadata(uploadB.id);
    await seedPlaylistItem(playlist.id, uploadA.id, { position: 0 });
    await seedPlaylistItem(playlist.id, uploadB.id, { position: 1 });

    const socket = connectSocket("rt-key-pl-1");
    await waitForEvent(socket, "connect");
    await emitWithAck(socket, "session:join", { sessionId: session.session.id });

    const statePromise = waitForEvent(socket, "state:sync");
    const activityPromise = waitForEvent(socket, "activity");
    const ack = await emitWithAck(socket, "queue:add-playlist", { playlistId: playlist.id });
    expect(ack.ok).toBe(true);

    const state = await statePromise;
    expect(state.nowPlaying.video.id).toBe(uploadA.id);
    expect(state.queue.map((item) => item.video.id)).toEqual([uploadB.id]);

    const activity = await activityPromise;
    expect(activity.type).toBe("queue_add");
    expect(activity.text).toContain("2 videos");
  }, 10000);

  test("react broadcasts a multi-codepoint emoji intact and records its use", async () => {
    await seedUserWithKey("rt-key-react-1");
    const session = await createSession("rt-key-react-1");
    const socket = connectSocket("rt-key-react-1");
    await waitForEvent(socket, "connect");
    await emitWithAck(socket, "session:join", { sessionId: session.session.id });

    // 11 UTF-16 code units - the old slice(0, 8) handling corrupted this.
    const reactPromise = waitForEvent(socket, "react");
    socket.emit("react", { emoji: "👨‍👩‍👧‍👦" });

    const payload = await reactPromise;
    expect(payload.emoji).toBe("👨‍👩‍👧‍👦");

    // The counter write is fire-and-forget, so give it a beat to land.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const row = await EmojiReactionUsage.findByPk("👨‍👩‍👧‍👦", { raw: true });
    expect(row).not.toBeNull();
    expect(Number(row.useCount)).toBe(1);
  }, 10000);

  test("react ignores a non-emoji payload entirely", async () => {
    await seedUserWithKey("rt-key-react-2");
    const session = await createSession("rt-key-react-2");
    const socket = connectSocket("rt-key-react-2");
    await waitForEvent(socket, "connect");
    await emitWithAck(socket, "session:join", { sessionId: session.session.id });

    let received = null;
    socket.on("react", (payload) => {
      received = payload;
    });
    socket.emit("react", { emoji: "<script>alert(1)</script>" });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(received).toBeNull();
    const rows = await EmojiReactionUsage.findAll({ where: {}, raw: true });
    expect(rows.every((row) => Number(row.useCount) === 0)).toBe(true);
  }, 10000);

  test("two members both reporting player:ended advance the queue exactly one item", async () => {
    // Every member's <video> fires `ended` at the same moment, so the server
    // gets one report per open tab. Before `queueItemId` the second report
    // retired the item the first had just promoted, and the party skipped a
    // video for every extra member.
    await seedUserWithKey("rt-key-end-a");
    const session = await createSession("rt-key-end-a");
    await seedUserWithKey("rt-key-end-b");
    await request(app)
      .post("/api/v1/cast/join")
      .set("Authorization", "Bearer rt-key-end-b")
      .send({ code: session.session.code });

    const socketA = connectSocket("rt-key-end-a");
    const socketB = connectSocket("rt-key-end-b");
    await Promise.all([waitForEvent(socketA, "connect"), waitForEvent(socketB, "connect")]);
    await emitWithAck(socketA, "session:join", { sessionId: session.session.id });
    await emitWithAck(socketB, "session:join", { sessionId: session.session.id });

    const uploads = [];
    for (let i = 0; i < 3; i += 1) {
      const upload = await seedUpload();
      await seedMetadata(upload.id);
      uploads.push(upload);
      await emitWithAck(socketA, "queue:add", { videoId: String(upload.id) });
    }

    const before = await request(app)
      .get(`/api/v1/cast/${session.session.id}`)
      .set("Authorization", "Bearer rt-key-end-a");
    expect(before.body.nowPlaying.video.id).toBe(uploads[0].id);
    const playingItemId = before.body.nowPlaying.id;

    // One after the other, which is what two real players a few milliseconds
    // apart produce: by the time B's report lands, A's has already promoted the
    // next item. B is reporting the item it was playing, which is no longer the
    // one playing, so it must change nothing.
    await emitWithAck(socketA, "player:ended", { queueItemId: playingItemId });
    await emitWithAck(socketB, "player:ended", { queueItemId: playingItemId });

    const after = await request(app)
      .get(`/api/v1/cast/${session.session.id}`)
      .set("Authorization", "Bearer rt-key-end-a");
    expect(after.body.nowPlaying.video.id).toBe(uploads[1].id);
    expect(after.body.queue.map((item) => item.video.id)).toEqual([uploads[2].id]);
  }, 15000);

  test("a REST kick forcibly disconnects the kicked member's live socket", async () => {
    await seedUserWithKey("rt-key-4a");
    const session = await createSession("rt-key-4a");
    const target = await seedUserWithKey("rt-key-4b");
    await request(app)
      .post("/api/v1/cast/join")
      .set("Authorization", "Bearer rt-key-4b")
      .send({ code: session.session.code });

    const targetSocket = connectSocket("rt-key-4b");
    await waitForEvent(targetSocket, "connect");
    await emitWithAck(targetSocket, "session:join", { sessionId: session.session.id });

    const kickedPromise = waitForEvent(targetSocket, "session:kicked");
    const disconnectPromise = waitForEvent(targetSocket, "disconnect");

    const res = await request(app)
      .delete(`/api/v1/cast/${session.session.id}/members/${target.id}`)
      .set("Authorization", "Bearer rt-key-4a");
    expect(res.status).toBe(204);

    await kickedPromise;
    await disconnectPromise;
  }, 10000);

  test("connecting without valid credentials is rejected", async () => {
    const socket = ioClient(`${baseUrl}/cast`, {
      transports: ["polling", "websocket"],
      forceNew: true,
    });
    openSockets.push(socket);

    const err = await waitForEvent(socket, "connect_error");
    expect(err).toBeTruthy();
  }, 10000);
});
