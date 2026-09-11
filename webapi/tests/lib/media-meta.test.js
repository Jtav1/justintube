import { describe, expect, test } from "@jest/globals";
import { plannedTranscodedStoragePath, userStorageSegment } from "../../lib/media-meta.js";

describe("userStorageSegment", () => {
  test("returns the stringified userId when present", () => {
    expect(userStorageSegment(42)).toBe("42");
  });

  test("falls back to _unowned for a null userId", () => {
    expect(userStorageSegment(null)).toBe("_unowned");
  });

  test("falls back to _unowned for an undefined userId", () => {
    expect(userStorageSegment(undefined)).toBe("_unowned");
  });
});

describe("plannedTranscodedStoragePath", () => {
  test("nests the path under the owning upload's userId subfolder", () => {
    expect(plannedTranscodedStoragePath(42, "abc-uuid", "mp4")).toBe(
      "transcoded/42/abc-uuid.mp4",
    );
  });

  test("nests under _unowned when userId is null", () => {
    expect(plannedTranscodedStoragePath(null, "abc-uuid", "mp4")).toBe(
      "transcoded/_unowned/abc-uuid.mp4",
    );
  });

  test("omits the extension when none is given", () => {
    expect(plannedTranscodedStoragePath(42, "abc-uuid", "")).toBe(
      "transcoded/42/abc-uuid",
    );
  });
});
