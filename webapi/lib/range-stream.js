import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

/**
 * Parses a single-range `Range: bytes=start-end` header against a known file
 * size. Only the first range in a comma-separated list is honored (multi-range
 * responses aren't supported).
 *
 * @param {string|undefined} rangeHeader Raw `Range` request header value.
 * @param {number} fileSize Total size of the file in bytes.
 * @returns {{start: number, end: number}|null|"unsatisfiable"} The parsed byte
 *   range; `null` when no/unparseable Range header is present (caller should
 *   serve the whole file); or `"unsatisfiable"` when the range is out of
 *   bounds (caller should send 416).
 */
export function parseRange(rangeHeader, fileSize) {
  if (!rangeHeader || !rangeHeader.startsWith("bytes=")) {
    return null;
  }

  const spec = rangeHeader.slice("bytes=".length).split(",")[0].trim();
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match || (match[1] === "" && match[2] === "")) {
    return null;
  }

  let start;
  let end;
  if (match[1] === "") {
    // Suffix range (e.g. "bytes=-500"): last N bytes of the file.
    const suffixLength = Number(match[2]);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return "unsatisfiable";
    }
    start = Math.max(fileSize - suffixLength, 0);
    end = fileSize - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? fileSize - 1 : Number(match[2]);
  }

  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start > end ||
    start < 0 ||
    start >= fileSize
  ) {
    return "unsatisfiable";
  }

  return { start, end: Math.min(end, fileSize - 1) };
}

/**
 * Streams a file to an HTTP response, honoring a `Range` request header with
 * standard byte-range semantics (206 Partial Content), and falling back to a
 * full 200 response when no Range header is present.
 *
 * @param {import('express').Request} req Incoming request (reads the `Range` header).
 * @param {import('express').Response} res Express response.
 * @param {string} absolutePath Absolute path to the file on disk.
 * @param {string|null} [contentType] MIME type for the `Content-Type` header.
 * @returns {Promise<void>} Resolves once headers are set and the stream is
 *   piped, or a 404/416 error response has been sent.
 */
export async function streamFileWithRangeSupport(
  req,
  res,
  absolutePath,
  contentType,
) {
  let stats;
  try {
    stats = await stat(absolutePath);
  } catch {
    res.status(404).json({
      error: "not_found",
      message: "Media file not found on disk.",
    });
    return;
  }

  const fileSize = stats.size;
  const range = parseRange(req.headers.range, fileSize);

  if (contentType) {
    res.setHeader("Content-Type", contentType);
  }
  res.setHeader("Accept-Ranges", "bytes");

  if (range === "unsatisfiable") {
    res.setHeader("Content-Range", `bytes */${fileSize}`);
    res.status(416).end();
    return;
  }

  if (range === null) {
    res.status(200);
    res.setHeader("Content-Length", String(fileSize));
    createReadStream(absolutePath).pipe(res);
    return;
  }

  const { start, end } = range;
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  res.setHeader("Content-Length", String(end - start + 1));
  createReadStream(absolutePath, { start, end }).pipe(res);
}
