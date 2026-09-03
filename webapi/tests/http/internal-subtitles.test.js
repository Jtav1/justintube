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
      .send({ subtitles: [{ outputFilename: `${upload.videoId}-0.vtt` }] });

    expect(res.status).toBe(401);
  });

  test("returns 400 when subtitles is missing", async () => {
    const upload = await seedUpload();

    const res = await client
      .post(`/internal/subtitles/${subtitleJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("returns 400 when an entry is missing outputFilename", async () => {
    const upload = await seedUpload();

    const res = await client
      .post(`/internal/subtitles/${subtitleJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ subtitles: [{ language: "eng" }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("returns 400 when the jobId isn't a well-formed subtitle-<videoId>-<uuid>", async () => {
    const res = await client
      .post("/internal/subtitles/not-a-subtitle-job/complete")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ subtitles: [{ outputFilename: "whatever.vtt" }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_uuid");
  });

  test("returns 404 for an unknown upload videoId", async () => {
    const res = await client
      .post(`/internal/subtitles/subtitle-000000-${randomUUID()}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ subtitles: [{ outputFilename: "whatever.vtt" }] });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("creates one VIDEO_SUBTITLE row (source: auto) per extracted stream", async () => {
    const upload = await seedUpload();

    const res = await client
      .post(`/internal/subtitles/${subtitleJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({
        subtitles: [
          { outputFilename: `${upload.videoId}-0.vtt`, language: "eng", title: "" },
          { outputFilename: `${upload.videoId}-1.vtt`, language: "spa", title: "Spanish" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      videoId: upload.videoId,
      status: "complete",
    });

    const rows = await queryRows(
      "SELECT * FROM VIDEO_SUBTITLE WHERE original_upload_id = :id ORDER BY id ASC",
      { id: upload.id },
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      subtitle_filename: `${upload.videoId}-0.vtt`,
      source: "auto",
      label: "eng",
    });
    expect(rows[1]).toMatchObject({
      subtitle_filename: `${upload.videoId}-1.vtt`,
      source: "auto",
      label: "Spanish",
    });
  });

  test("falls back to a positional label when neither title nor language is present", async () => {
    const upload = await seedUpload();

    const res = await client
      .post(`/internal/subtitles/${subtitleJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ subtitles: [{ outputFilename: `${upload.videoId}-0.vtt` }] });

    expect(res.status).toBe(200);

    const rows = await queryRows(
      "SELECT * FROM VIDEO_SUBTITLE WHERE original_upload_id = :id",
      { id: upload.id },
    );
    expect(rows[0].label).toBe("Subtitle 1");
  });

  test("replaces the prior auto set (simulating a regenerate) without touching user-uploaded rows", async () => {
    const upload = await seedUpload();
    const staleAuto = await seedVideoSubtitle(upload.id, {
      subtitleFilename: `${upload.userId ?? "_unowned"}/old.vtt`,
      source: "auto",
    });
    const oldPath = writeMediaFixture(
      `subtitles/${staleAuto.subtitleFilename}`,
      "WEBVTT\n\nold",
    );
    const userProvided = await seedVideoSubtitle(upload.id, {
      subtitleFilename: `${upload.userId ?? "_unowned"}/mine.vtt`,
      source: "user",
      label: "My subtitle",
    });
    const keptPath = writeMediaFixture(
      `subtitles/${userProvided.subtitleFilename}`,
      "WEBVTT\n\nmine",
    );
    const newFilename = `${upload.userId ?? "_unowned"}/new.vtt`;

    const res = await client
      .post(`/internal/subtitles/${subtitleJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ subtitles: [{ outputFilename: newFilename, language: "eng" }] });

    expect(res.status).toBe(200);

    const rows = await queryRows(
      "SELECT * FROM VIDEO_SUBTITLE WHERE original_upload_id = :id ORDER BY id ASC",
      { id: upload.id },
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.source === "auto").subtitle_filename).toBe(newFilename);
    expect(rows.find((r) => r.source === "user").subtitle_filename).toBe(
      userProvided.subtitleFilename,
    );
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(keptPath)).toBe(true);
  });

  test("an empty subtitles array clears the prior auto set", async () => {
    const upload = await seedUpload();
    const staleAuto = await seedVideoSubtitle(upload.id, { source: "auto" });
    writeMediaFixture(`subtitles/${staleAuto.subtitleFilename}`, "WEBVTT\n\nold");

    const res = await client
      .post(`/internal/subtitles/${subtitleJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ subtitles: [] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("no_subtitle_streams");

    const rows = await queryRows(
      "SELECT * FROM VIDEO_SUBTITLE WHERE original_upload_id = :id",
      { id: upload.id },
    );
    expect(rows).toHaveLength(0);
  });

  test("skips entirely when the upload has a user-provided subtitle (skipAutoSubtitles)", async () => {
    const upload = await seedUpload({ skipAutoSubtitles: true });

    const res = await client
      .post(`/internal/subtitles/${subtitleJobId(upload)}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ subtitles: [{ outputFilename: "late-auto-extracted.vtt", language: "eng" }] });

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
