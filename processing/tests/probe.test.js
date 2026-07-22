import { describe, expect, test } from "@jest/globals";
import {
  heightToResolution,
  mimeTypeForContainer,
} from "../lib/probe.js";

describe("heightToResolution", () => {
  test("maps common heights to resolution labels", () => {
    expect(heightToResolution(720)).toBe("720p");
    expect(heightToResolution(1080)).toBe("1080p");
    expect(heightToResolution(2160)).toBe("4kHD");
  });

  test("returns null for invalid heights", () => {
    expect(heightToResolution(0)).toBeNull();
    expect(heightToResolution(-1)).toBeNull();
  });
});

describe("mimeTypeForContainer", () => {
  test("maps known containers", () => {
    expect(mimeTypeForContainer("mp4")).toBe("video/mp4");
    expect(mimeTypeForContainer(".webm")).toBe("video/webm");
  });

  test("returns null for unknown containers", () => {
    expect(mimeTypeForContainer("xyz")).toBeNull();
  });
});
