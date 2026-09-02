import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { mediaDir } from "../../lib/media-meta.js";
import { createTestClient } from "../helpers/app.js";
import {
  queryRows,
  resetTables,
  seedUpload,
  seedVideoSubtitle,
  setupSchema,
} from "../helpers/db.js";

const TOKEN = "test-internal-token";

/**
 * Builds a `subtitle-<videoId>-<uuid>` BullMQ jobId, matching what
 * `routes/uploads.js`/`routes/videos.js` actually enqueue subtitle jobs
 * with, for use as the `:jobId` route param in these callback tests.
 *
 * @param {import('sequelize').Model} upload Seeded upload.
 * @returns {string} A well-formed subtitle jobId for `upload`.
 */
function subtitleJobId(upload) {
  return `subtitle-${upload.videoId}-${randomUUID()}`;
}

/**
 * Writes a fixture file under the test media root at a given relative
 * storage path (e.g. "subtitles/foo.vtt"), creating parent directories as
 * needed.
 *
 * @param {string} relativeStoragePath Path relative to `mediaDir`.
 * @param {Buffer|string} contents File contents to write.
 * @returns {string} The absolute path the file was written to.
 */
function writeMediaFixture(relativeStoragePath, contents) {
  const absolutePath = join(mediaDir, relativeStoragePath);
  mkdirSync(join(absolutePath, ".."), { recursive: true });
  writeFileSync(absolutePath, contents);
  return absolutePath;
}

/**
 * HTTP tests for the processing → API subtitle-extraction callback.
 */
describe("POST /internal/subtitles/:jobId/complete", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("rejects missing bearer token", async () => {
    const upload = await seedUpload();

    const res = await client
      .post(`/internal/subtitles/${subtitleJobId(upload)}/complete`)
      .send({ subtitleFilename: `${upload.videoId}.vtt` });

    expect(res.status).toBe(401);
  });

  test("returns 400 when subtitleFilename is missing", async () => {
    const upload = await seedUpload();

    const res = await client
      .post(`/internal/subtitles/${subtitleJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("returns 400 when the jobId isn't a well-formed subtitle-<videoId>-<uuid>", async () => {
    const res = await client
      .post("/internal/subtitles/not-a-subtitle-job/complete")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ subtitleFilename: "whatever.vtt" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_uuid");
  });

  test("returns 404 for an unknown upload videoId", async () => {
    const res = await client
      .post(`/internal/subtitles/subtitle-000000-${randomUUID()}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ subtitleFilename: "whatever.vtt" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("creates a VIDEO_SUBTITLE row (source: auto) on first success", async () => {
    const upload = await seedUpload();
    const subtitleFilename = `${upload.videoId}.vtt`;

    const res = await client
      .post(`/internal/subtitles/${subtitleJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ subtitleFilename });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      videoId: upload.videoId,
      status: "complete",
    });

    const rows = await queryRows(
      "SELECT * FROM VIDEO_SUBTITLE WHERE original_upload_id = :id",
      { id: upload.id },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].subtitle_filename).toBe(subtitleFilename);
    expect(rows[0].source).toBe("auto");
  });

  test("replaces the file+row (simulating a regenerate) rather than erroring when one already exists", async () => {
    const upload = await seedUpload();
    const existing = await seedVideoSubtitle(upload.id, {
      subtitleFilename: `${upload.userId ?? "_unowned"}/old.vtt`,
      source: "auto",
    });
    const oldPath = writeMediaFixture(
      `subtitles/${existing.subtitleFilename}`,
      "WEBVTT\n\nold",
    );
    const newFilename = `${upload.userId ?? "_unowned"}/new.vtt`;

    const res = await client
      .post(`/internal/subtitles/${subtitleJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ subtitleFilename: newFilename });

    expect(res.status).toBe(200);

    const rows = await queryRows(
      "SELECT * FROM VIDEO_SUBTITLE WHERE original_upload_id = :id",
      { id: upload.id },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].subtitle_filename).toBe(newFilename);
    expect(existsSync(oldPath)).toBe(false);
  });

  test("skips entirely when the upload has a user-provided subtitle (skipAutoSubtitles)", async () => {
    const upload = await seedUpload({ skipAutoSubtitles: true });

    const res = await client
      .post(`/internal/subtitles/${subtitleJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ subtitleFilename: "late-auto-extracted.vtt" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("skipped_user_provided");

    const rows = await queryRows(
      "SELECT * FROM VIDEO_SUBTITLE WHERE original_upload_id = :id",
      { id: upload.id },
    );
    expect(rows).toHaveLength(0);
  });
});

/**
 * HTTP tests for the processing → API subtitle-extraction *failure* (or
 * graceful-skip, e.g. no text-based subtitle stream present) callback.
 */
describe("POST /internal/subtitles/:jobId/failed", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("rejects missing bearer token", async () => {
    const upload = await seedUpload();

    const res = await client
      .post(`/internal/subtitles/${subtitleJobId(upload)}/failed`)
      .send({ error: "no text-based subtitle stream found" });

    expect(res.status).toBe(401);
  });

  test("returns 400 when the jobId isn't a well-formed subtitle-<videoId>-<uuid>", async () => {
    const res = await client
      .post("/internal/subtitles/not-a-subtitle-job/failed")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ error: "no text-based subtitle stream found" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_uuid");
  });

  test("returns 404 for an unknown upload videoId", async () => {
    const res = await client
      .post(`/internal/subtitles/subtitle-000000-${randomUUID()}/failed`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ error: "no text-based subtitle stream found" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("acknowledges cleanly for an upload with no existing subtitle", async () => {
    const upload = await seedUpload();

    const res = await client
      .post(`/internal/subtitles/${subtitleJobId(upload)}/failed`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ error: "no text-based subtitle stream found" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, videoId: upload.videoId });

    const rows = await queryRows(
      "SELECT * FROM VIDEO_SUBTITLE WHERE original_upload_id = :id",
      { id: upload.id },
    );
    expect(rows).toHaveLength(0);
  });

  test("leaves an existing subtitle (e.g. from a no-track-found regeneration) completely untouched", async () => {
    const upload = await seedUpload();
    const existing = await seedVideoSubtitle(upload.id, {
      subtitleFilename: `${upload.userId ?? "_unowned"}/keep.vtt`,
      source: "user",
    });
    const keptPath = writeMediaFixture(
      `subtitles/${existing.subtitleFilename}`,
      "WEBVTT\n\nkeep me",
    );

    const res = await client
      .post(`/internal/subtitles/${subtitleJobId(upload)}/failed`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ error: "no text-based subtitle stream found" });

    expect(res.status).toBe(200);

    const rows = await queryRows(
      "SELECT * FROM VIDEO_SUBTITLE WHERE original_upload_id = :id",
      { id: upload.id },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].subtitle_filename).toBe(existing.subtitleFilename);
    expect(rows[0].source).toBe("user");
    expect(existsSync(keptPath)).toBe(true);
  });
});
