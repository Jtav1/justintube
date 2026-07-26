import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import { queryRows, resetTables, seedTranscodeProfile, setupSchema } from "../helpers/db.js";
import { originalDir } from "../../routes/uploads.js";

/**
 * HTTP contract tests for the URL-import endpoint (`POST /videos/import`).
 * The route asks processing to download the URL via yt-dlp into the shared
 * `original/` media directory, then reuses the same FILE_VERSIONS /
 * transcode-enqueue path as `POST /videos/upload`. Tests simulate the
 * processing side effect (the downloaded file landing in `original/`) by
 * writing a fixture there before mocking the `/download` response.
 */
describe("POST /videos/import (ORIGINAL_UPLOADS via URL download)", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;
  /** @type {typeof fetch | undefined} */
  let originalFetch;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
    mkdirSync(originalDir, { recursive: true });
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await resetTables();
  });

  /**
   * Writes a fixture file into `original/` to stand in for the file
   * processing would have written there via yt-dlp.
   *
   * @param {string} name Basename to create under `original/`.
   * @returns {void}
   */
  function writeDownloadedFixture(name) {
    writeFileSync(join(originalDir, name), Buffer.from("fake-video"));
  }

  test("downloads a video from a URL and persists an ORIGINAL_UPLOADS row", async () => {
    writeDownloadedFixture("1737900000.mp4");
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, filename: "1737900000.mp4" }),
    }));
    globalThis.fetch = fetchMock;

    const res = await client
      .post("/api/v1/videos/import")
      .send({ url: "https://example.com/watch?v=abc" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      originalFilename: "1737900000.mp4",
      fileExtension: "mp4",
      status: "uploaded",
      userId: null,
    });
    expect(typeof res.body.uuidName).toBe("string");
    expect(res.body.uuidName).toHaveLength(36);
    expect(res.body.storagePath).toBe(`original/${res.body.uuidName}.mp4`);
    expect(res.body.fileVersions).toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://processing.test:3001/download");
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(payload.url).toBe("https://example.com/watch?v=abc");

    expect(existsSync(join(originalDir, `${res.body.uuidName}.mp4`))).toBe(true);
    expect(existsSync(join(originalDir, "1737900000.mp4"))).toBe(false);

    const rows = await queryRows(
      "SELECT * FROM ORIGINAL_UPLOADS WHERE uuid_name = :uuidName",
      { uuidName: res.body.uuidName },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].original_filename).toBe("1737900000.mp4");
    expect(rows[0].status).toBe("uploaded");
  });

  test("batch-enqueues jobs and creates pending FILE_VERSIONS", async () => {
    writeDownloadedFixture("1737900001.mp4");
    const profile = await seedTranscodeProfile({
      outputHeight: 720,
      outputWidth: 1280,
      outputContainer: "mp4",
      videoCodec: "h264",
      audioCodec: "aac",
    });

    const fetchMock = jest.fn(async (url, options) => {
      if (url === "http://processing.test:3001/download") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, filename: "1737900001.mp4" }),
        };
      }
      const body = JSON.parse(String(options.body));
      return {
        ok: true,
        status: 202,
        json: async () => ({
          success: true,
          jobs: body.jobs.map((job) => ({
            jobId: job.jobId,
            outputFilename: job.outputFilename,
            profileId: job.profile.id,
          })),
        }),
      };
    });
    globalThis.fetch = fetchMock;

    const res = await client
      .post("/api/v1/videos/import")
      .send({ url: "https://example.com/watch?v=xyz" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("processing");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const transcodeCall = fetchMock.mock.calls.find(
      (call) => call[0] === "http://processing.test:3001/transcode",
    );
    const payload = JSON.parse(String(transcodeCall[1].body));
    expect(payload.filename).toBe(`${res.body.uuidName}.mp4`);
    expect(payload.jobs).toHaveLength(1);
    expect(payload.jobs[0].profile.id).toBe(profile.id);

    expect(res.body.fileVersions).toHaveLength(1);
    expect(res.body.fileVersions[0].status).toBe("processing");

    const versionRows = await queryRows(
      "SELECT * FROM FILE_VERSIONS WHERE original_upload_id = :id",
      { id: res.body.id },
    );
    expect(versionRows).toHaveLength(1);
  });

  test("returns 400 invalid_body when url is missing", async () => {
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock;

    const res = await client.post("/api/v1/videos/import").send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns 400 invalid_body when url is not http(s)", async () => {
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock;

    const res = await client
      .post("/api/v1/videos/import")
      .send({ url: "ftp://example.com/video.mp4" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns 502 import_download_failed when processing fails to download", async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ success: false, error: "yt-dlp failed" }),
    }));

    const res = await client
      .post("/api/v1/videos/import")
      .send({ url: "https://example.com/watch?v=abc" });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("import_download_failed");
    expect(res.body.message).toBe("yt-dlp failed");
  });

  test("returns 503 processing_unavailable when processing is unreachable", async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error("fetch failed");
    });

    const res = await client
      .post("/api/v1/videos/import")
      .send({ url: "https://example.com/watch?v=abc" });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("processing_unavailable");
  });

  test("returns 500 import_persist_failed when the downloaded file is missing on disk", async () => {
    // No fixture written: processing claims success but the file isn't there.
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, filename: "does-not-exist.mp4" }),
    }));

    const res = await client
      .post("/api/v1/videos/import")
      .send({ url: "https://example.com/watch?v=abc" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("import_persist_failed");
  });
});
