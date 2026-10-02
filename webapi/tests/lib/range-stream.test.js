import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { parseRange, streamFileWithRangeSupport } from "../../lib/range-stream.js";

/**
 * Minimal fake Express response: a writable stream (so `.pipe()` works) plus
 * the handful of response methods `streamFileWithRangeSupport` calls.
 *
 * @returns {import('stream').PassThrough & Record<string, unknown>} Fake response.
 */
function createFakeRes() {
  const res = new PassThrough();
  const chunks = [];
  res.on("data", (chunk) => chunks.push(chunk));
  res.headers = {};
  res.headersSent = false;
  res.status = (code) => {
    res.statusCode = code;
    res.headersSent = true;
    return res;
  };
  res.setHeader = (name, value) => {
    res.headers[name] = value;
  };
  res.json = (body) => {
    res.jsonBody = body;
    res.end();
    return res;
  };
  res.body = () => Buffer.concat(chunks);
  return res;
}

describe("parseRange", () => {
  test("returns null when no Range header is present", () => {
    expect(parseRange(undefined, 1000)).toBeNull();
  });

  test("returns null for a non-bytes unit", () => {
    expect(parseRange("items=0-10", 1000)).toBeNull();
  });

  test("parses a bounded range", () => {
    expect(parseRange("bytes=0-499", 1000)).toEqual({ start: 0, end: 499 });
  });

  test("parses an open-ended range (to end of file)", () => {
    expect(parseRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
  });

  test("parses a suffix range (last N bytes)", () => {
    expect(parseRange("bytes=-500", 1000)).toEqual({ start: 500, end: 999 });
  });

  test("clamps an end beyond the file size", () => {
    expect(parseRange("bytes=0-9999", 1000)).toEqual({ start: 0, end: 999 });
  });

  test("only honors the first range in a comma-separated list", () => {
    expect(parseRange("bytes=0-99,200-299", 1000)).toEqual({
      start: 0,
      end: 99,
    });
  });

  test("returns unsatisfiable when start is beyond the file size", () => {
    expect(parseRange("bytes=2000-3000", 1000)).toBe("unsatisfiable");
  });

  test("returns unsatisfiable when start is after end", () => {
    expect(parseRange("bytes=500-100", 1000)).toBe("unsatisfiable");
  });

  test("returns unsatisfiable for a zero-length suffix", () => {
    expect(parseRange("bytes=-0", 1000)).toBe("unsatisfiable");
  });
});

describe("streamFileWithRangeSupport", () => {
  /** @type {string} */
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "range-stream-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns 404 instead of crashing when the path doesn't exist", async () => {
    const res = createFakeRes();
    await streamFileWithRangeSupport(
      { headers: {} },
      res,
      join(dir, "missing.mp4"),
      "video/mp4",
    );
    expect(res.statusCode).toBe(404);
    expect(res.jsonBody).toMatchObject({ error: "not_found" });
  });

  test("returns 404 instead of crashing when the path is a directory (EISDIR)", async () => {
    // Mirrors resolveMediaPath("") resolving to the media root itself when an
    // ORIGINAL_UPLOADS row has an empty storagePath (an abandoned import) -
    // this must not attempt to read the directory as a file.
    const res = createFakeRes();
    await streamFileWithRangeSupport({ headers: {} }, res, dir, "video/mp4");
    expect(res.statusCode).toBe(404);
    expect(res.jsonBody).toMatchObject({ error: "not_found" });
  });

  test("streams a whole file with a 200 when no Range header is present", async () => {
    const filePath = join(dir, "video.mp4");
    await writeFile(filePath, "hello world");

    const res = createFakeRes();
    const done = new Promise((resolve) => res.on("finish", resolve));
    await streamFileWithRangeSupport({ headers: {} }, res, filePath, "video/mp4");
    await done;

    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("video/mp4");
    expect(res.body().toString("utf8")).toBe("hello world");
  });

  test("streams a byte range with a 206", async () => {
    const filePath = join(dir, "video.mp4");
    await writeFile(filePath, "hello world");

    const res = createFakeRes();
    const done = new Promise((resolve) => res.on("finish", resolve));
    await streamFileWithRangeSupport(
      { headers: { range: "bytes=0-4" } },
      res,
      filePath,
      "video/mp4",
    );
    await done;

    expect(res.statusCode).toBe(206);
    expect(res.body().toString("utf8")).toBe("hello");
  });
});
