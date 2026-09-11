import { describe, expect, test } from "@jest/globals";
import {
  DownloadValidationError,
  FORMAT_SELECTOR,
  validateDownloadUrl,
} from "../lib/download.js";

describe("FORMAT_SELECTOR", () => {
  test("falls back to bestaudio for audio-only sources", () => {
    // Regression guard: every earlier alternative filters on `height`, so
    // without this fallback yt-dlp fails outright on audio-only sources
    // (no available format carries a height).
    expect(FORMAT_SELECTOR.endsWith("/bestaudio")).toBe(true);
  });
});

describe("validateDownloadUrl", () => {
  test("accepts a trimmed absolute http(s) URL", () => {
    expect(validateDownloadUrl("  https://example.com/watch?v=abc  ")).toBe(
      "https://example.com/watch?v=abc",
    );
  });

  test("rejects a missing/empty url", () => {
    expect(() => validateDownloadUrl("")).toThrow(DownloadValidationError);
    expect(() => validateDownloadUrl(undefined)).toThrow(DownloadValidationError);
  });

  test("rejects a malformed url", () => {
    expect(() => validateDownloadUrl("not a url")).toThrow(DownloadValidationError);
  });

  test("rejects a non-http(s) protocol", () => {
    expect(() => validateDownloadUrl("ftp://example.com/file")).toThrow(
      DownloadValidationError,
    );
  });
});
