import { describe, expect, test } from "@jest/globals";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DownloadValidationError,
  FORMAT_SELECTOR,
  parseYtDlpOptions,
  validateDownloadUrl,
  validateOptionalAudioFormat,
  validateOptionalCookies,
  validateOptionalLimit,
  validateOptionalRateLimit,
  validateOptionalRetries,
  withCookiesFile,
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

describe("validateOptionalRateLimit", () => {
  test("accepts undefined/null/empty as absent", () => {
    expect(validateOptionalRateLimit(undefined)).toBeUndefined();
    expect(validateOptionalRateLimit(null)).toBeUndefined();
    expect(validateOptionalRateLimit("")).toBeUndefined();
  });

  test("accepts a byte-rate token with a unit suffix", () => {
    expect(validateOptionalRateLimit("2M")).toBe("2M");
    expect(validateOptionalRateLimit("500K")).toBe("500K");
  });

  test("accepts a bare numeric byte count", () => {
    expect(validateOptionalRateLimit(1024)).toBe("1024");
  });

  test("rejects a malformed value", () => {
    expect(() => validateOptionalRateLimit("fast")).toThrow(DownloadValidationError);
    expect(() => validateOptionalRateLimit("2 M")).toThrow(DownloadValidationError);
  });
});

describe("validateOptionalRetries", () => {
  test("accepts undefined/null as absent", () => {
    expect(validateOptionalRetries(undefined)).toBeUndefined();
    expect(validateOptionalRetries(null)).toBeUndefined();
  });

  test("accepts an in-range integer", () => {
    expect(validateOptionalRetries(5)).toBe(5);
    expect(validateOptionalRetries(0)).toBe(0);
  });

  test("rejects a non-integer or out-of-range value", () => {
    expect(() => validateOptionalRetries(1.5)).toThrow(DownloadValidationError);
    expect(() => validateOptionalRetries(-1)).toThrow(DownloadValidationError);
    expect(() => validateOptionalRetries(9999)).toThrow(DownloadValidationError);
  });
});

describe("validateOptionalCookies", () => {
  test("accepts undefined/null/empty as absent", () => {
    expect(validateOptionalCookies(undefined)).toBeUndefined();
    expect(validateOptionalCookies(null)).toBeUndefined();
    expect(validateOptionalCookies("")).toBeUndefined();
  });

  test("accepts a non-empty string", () => {
    expect(validateOptionalCookies("# Netscape HTTP Cookie File")).toBe(
      "# Netscape HTTP Cookie File",
    );
  });

  test("rejects a non-string value", () => {
    expect(() => validateOptionalCookies(123)).toThrow(DownloadValidationError);
  });

  test("rejects content exceeding the size cap", () => {
    expect(() => validateOptionalCookies("a".repeat(1_000_001))).toThrow(
      DownloadValidationError,
    );
  });
});

describe("validateOptionalAudioFormat", () => {
  test("defaults to \"best\" when absent", () => {
    expect(validateOptionalAudioFormat(undefined)).toBe("best");
    expect(validateOptionalAudioFormat(null)).toBe("best");
    expect(validateOptionalAudioFormat("")).toBe("best");
  });

  test("accepts a recognized format, normalized to lowercase", () => {
    expect(validateOptionalAudioFormat("mp3")).toBe("mp3");
    expect(validateOptionalAudioFormat("MP3")).toBe("mp3");
  });

  test("rejects an unrecognized format", () => {
    expect(() => validateOptionalAudioFormat("wma")).toThrow(DownloadValidationError);
  });
});

describe("validateOptionalLimit", () => {
  test("accepts undefined/null as absent", () => {
    expect(validateOptionalLimit(undefined)).toBeUndefined();
    expect(validateOptionalLimit(null)).toBeUndefined();
  });

  test("accepts a positive integer", () => {
    expect(validateOptionalLimit(10)).toBe(10);
  });

  test("rejects a non-positive-integer value", () => {
    expect(() => validateOptionalLimit(0)).toThrow(DownloadValidationError);
    expect(() => validateOptionalLimit(-5)).toThrow(DownloadValidationError);
    expect(() => validateOptionalLimit(1.5)).toThrow(DownloadValidationError);
  });
});

describe("parseYtDlpOptions", () => {
  test("validates and passes through all three options", () => {
    expect(
      parseYtDlpOptions({ cookies: "jar", rateLimit: "2M", retries: 3 }),
    ).toEqual({ cookies: "jar", rateLimit: "2M", retries: 3 });
  });

  test("tolerates a missing/non-object body", () => {
    expect(parseYtDlpOptions(undefined)).toEqual({
      cookies: undefined,
      rateLimit: undefined,
      retries: undefined,
    });
  });
});

describe("withCookiesFile", () => {
  test("runs task with no extra args and skips file handling when cookies is absent", async () => {
    const task = async (cookieArgs) => {
      expect(cookieArgs).toEqual([]);
      return "result";
    };

    await expect(withCookiesFile(undefined, task)).resolves.toBe("result");
  });

  test("writes cookies to a temp file, passes --cookies args, and deletes it on success", async () => {
    let capturedPath;

    const result = await withCookiesFile("# cookie content", async (cookieArgs) => {
      expect(cookieArgs[0]).toBe("--cookies");
      capturedPath = cookieArgs[1];
      expect(existsSync(capturedPath)).toBe(true);
      expect(readFileSync(capturedPath, "utf8")).toBe("# cookie content");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(existsSync(capturedPath)).toBe(false);
    expect(existsSync(dirname(capturedPath))).toBe(false);
  });

  test("still deletes the temp file when task throws", async () => {
    let capturedPath;

    await expect(
      withCookiesFile("# cookie content", async (cookieArgs) => {
        capturedPath = cookieArgs[1];
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(existsSync(capturedPath)).toBe(false);
    expect(existsSync(dirname(capturedPath))).toBe(false);
  });
});
