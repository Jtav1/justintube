import { describe, expect, test } from "@jest/globals";
import { parseRange } from "../../lib/range-stream.js";

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
