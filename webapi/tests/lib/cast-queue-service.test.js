import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { CastQueueItem, CastSession } from "../../lib/models/index.js";
import {
  controlPlayback,
  effectivePosition,
  promoteNextQueuedItemIfIdle,
  reorderQueueItem,
} from "../../lib/cast/queue-service.js";
import {
  resetTables,
  seedCastQueueItem,
  seedCastSession,
  seedMetadata,
  seedUpload,
  seedUser,
  setupSchema,
} from "../helpers/db.js";

/**
 * Unit tests for lib/cast/queue-service.js's pure/near-pure logic: the
 * server-authoritative playback clock's effective-position calculation,
 * auto-advance promotion, and queue-reorder position math. REST-surface
 * behavior (auth, visibility enforcement, the full create/join/kick/end
 * lifecycle) is covered end-to-end in tests/http/cast.test.js instead - this
 * file exercises the service functions directly so that logic doesn't need
 * an HTTP round-trip to verify.
 */
describe("lib/cast/queue-service.js", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  async function seedSessionWithOwner() {
    const owner = await seedUser();
    const session = await seedCastSession({ ownerUserId: owner.id });
    return { owner, session };
  }

  async function seedQueuedVideo() {
    const upload = await seedUpload();
    await seedMetadata(upload.id);
    return upload;
  }

  describe("effectivePosition", () => {
    test("returns the stored position unchanged while paused", () => {
      const session = CastSession.build({
        playbackStatus: "paused",
        playbackPositionSeconds: 42,
        playbackUpdatedAt: new Date(Date.now() - 10_000),
      });
      expect(effectivePosition(session)).toBe(42);
    });

    test("returns the stored position unchanged when never started (no playbackUpdatedAt)", () => {
      const session = CastSession.build({
        playbackStatus: "playing",
        playbackPositionSeconds: 0,
        playbackUpdatedAt: null,
      });
      expect(effectivePosition(session)).toBe(0);
    });

    test("adds elapsed wall-clock time while playing", () => {
      const session = CastSession.build({
        playbackStatus: "playing",
        playbackPositionSeconds: 10,
        playbackUpdatedAt: new Date(Date.now() - 5_000),
      });
      const position = effectivePosition(session);
      // Allow generous slack for test-runner scheduling jitter - only the
      // direction and rough magnitude of the elapsed-time addition matter here.
      expect(position).toBeGreaterThanOrEqual(14.5);
      expect(position).toBeLessThanOrEqual(16);
    });
  });

  describe("promoteNextQueuedItemIfIdle", () => {
    test("promotes the lowest-position queued item when nothing is playing", async () => {
      const { session } = await seedSessionWithOwner();
      const uploadA = await seedQueuedVideo();
      const uploadB = await seedQueuedVideo();
      const sessionRow = await CastSession.findByPk(session.id);
      await seedCastQueueItem(session.id, uploadB.id, { position: 1 });
      await seedCastQueueItem(session.id, uploadA.id, { position: 0 });

      await promoteNextQueuedItemIfIdle(sessionRow);

      const rows = await CastQueueItem.findAll({ where: { castSessionId: session.id } });
      const playing = rows.find((row) => row.status === "playing");
      const stillQueued = rows.find((row) => row.status === "queued");
      expect(playing.originalUploadId).toBe(uploadA.id);
      expect(stillQueued.originalUploadId).toBe(uploadB.id);
      expect(playing.playedAt).not.toBeNull();

      await sessionRow.reload();
      expect(sessionRow.playbackStatus).toBe("playing");
      expect(sessionRow.playbackPositionSeconds).toBe(0);
      expect(sessionRow.playbackUpdatedAt).not.toBeNull();
    });

    test("is a no-op when something is already playing", async () => {
      const { session } = await seedSessionWithOwner();
      const uploadA = await seedQueuedVideo();
      const uploadB = await seedQueuedVideo();
      await seedCastQueueItem(session.id, uploadA.id, { status: "playing", position: null });
      await seedCastQueueItem(session.id, uploadB.id, { status: "queued", position: 0 });
      const sessionRow = await CastSession.findByPk(session.id);

      await promoteNextQueuedItemIfIdle(sessionRow);

      const stillQueued = await CastQueueItem.findAll({
        where: { castSessionId: session.id, status: "queued" },
      });
      expect(stillQueued).toHaveLength(1);
      expect(stillQueued[0].originalUploadId).toBe(uploadB.id);
    });

    test("is a no-op when the queue is empty", async () => {
      const { session } = await seedSessionWithOwner();
      const sessionRow = await CastSession.findByPk(session.id);

      await promoteNextQueuedItemIfIdle(sessionRow);

      const rows = await CastQueueItem.findAll({ where: { castSessionId: session.id } });
      expect(rows).toHaveLength(0);
    });
  });

  describe("reorderQueueItem", () => {
    test("moves an item to a later position and renumbers the rest", async () => {
      const { session } = await seedSessionWithOwner();
      const uploadA = await seedQueuedVideo();
      const uploadB = await seedQueuedVideo();
      const uploadC = await seedQueuedVideo();
      const itemA = await seedCastQueueItem(session.id, uploadA.id, { position: 0 });
      await seedCastQueueItem(session.id, uploadB.id, { position: 1 });
      await seedCastQueueItem(session.id, uploadC.id, { position: 2 });
      const sessionRow = await CastSession.findByPk(session.id);

      await reorderQueueItem({ session: sessionRow, queueItemId: itemA.id, toIndex: 2 });

      const ordered = await CastQueueItem.findAll({
        where: { castSessionId: session.id, status: "queued" },
        order: [["position", "ASC"]],
      });
      expect(ordered.map((row) => row.originalUploadId)).toEqual([
        uploadB.id,
        uploadC.id,
        uploadA.id,
      ]);
      expect(ordered.map((row) => row.position)).toEqual([0, 1, 2]);
    });

    test("clamps an out-of-range toIndex to the end of the queue", async () => {
      const { session } = await seedSessionWithOwner();
      const uploadA = await seedQueuedVideo();
      const uploadB = await seedQueuedVideo();
      const itemA = await seedCastQueueItem(session.id, uploadA.id, { position: 0 });
      await seedCastQueueItem(session.id, uploadB.id, { position: 1 });
      const sessionRow = await CastSession.findByPk(session.id);

      await reorderQueueItem({ session: sessionRow, queueItemId: itemA.id, toIndex: 99 });

      const ordered = await CastQueueItem.findAll({
        where: { castSessionId: session.id, status: "queued" },
        order: [["position", "ASC"]],
      });
      expect(ordered.map((row) => row.originalUploadId)).toEqual([uploadB.id, uploadA.id]);
    });

    test("throws not_found for a queue item id that isn't currently queued", async () => {
      const { session } = await seedSessionWithOwner();
      const sessionRow = await CastSession.findByPk(session.id);

      await expect(
        reorderQueueItem({ session: sessionRow, queueItemId: 999999, toIndex: 0 }),
      ).rejects.toMatchObject({ status: 404, code: "not_found" });
    });
  });

  describe("controlPlayback", () => {
    test("skip marks the playing item skipped and promotes the next queued item", async () => {
      const { session } = await seedSessionWithOwner();
      const uploadA = await seedQueuedVideo();
      const uploadB = await seedQueuedVideo();
      await seedCastQueueItem(session.id, uploadA.id, { status: "playing", position: null });
      await seedCastQueueItem(session.id, uploadB.id, { status: "queued", position: 0 });
      const sessionRow = await CastSession.findByPk(session.id);

      await controlPlayback({ session: sessionRow, action: "skip" });

      const rows = await CastQueueItem.findAll({ where: { castSessionId: session.id } });
      const skipped = rows.find((row) => row.originalUploadId === uploadA.id);
      const promoted = rows.find((row) => row.originalUploadId === uploadB.id);
      expect(skipped.status).toBe("skipped");
      expect(promoted.status).toBe("playing");
    });

    test("rejects further mutation once the session has ended", async () => {
      const { session } = await seedSessionWithOwner();
      const sessionRow = await CastSession.findByPk(session.id);
      sessionRow.status = "ended";
      await sessionRow.save();

      await expect(
        controlPlayback({ session: sessionRow, action: "play" }),
      ).rejects.toMatchObject({ status: 409, code: "session_ended" });
    });
  });
});
