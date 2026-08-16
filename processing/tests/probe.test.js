import { describe, expect, test } from "@jest/globals";
import {
  heightToResolution,
  mimeTypeForContainer,
  shouldSkipProfileForOrientation,
  shouldSkipProfileForSource,
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
    expect(mimeTypeForContainer("m4a")).toBe("audio/mp4");
  });

  test("returns null for unknown containers", () => {
    expect(mimeTypeForContainer("xyz")).toBeNull();
  });
});

describe("shouldSkipProfileForSource", () => {
  test("skips profiles that would upscale either axis", () => {
    const source = { videoWidth: 1280, videoHeight: 720 };
    expect(
      shouldSkipProfileForSource(
        { outputWidth: 1920, outputHeight: 1080 },
        source,
      ),
    ).toBe(true);
    expect(
      shouldSkipProfileForSource(
        { outputWidth: 1280, outputHeight: 1080 },
        source,
      ),
    ).toBe(true);
  });

  test("keeps profiles at or below source resolution", () => {
    const source = { videoWidth: 1920, videoHeight: 1080 };
    expect(
      shouldSkipProfileForSource(
        { outputWidth: 1280, outputHeight: 720 },
        source,
      ),
    ).toBe(false);
    expect(
      shouldSkipProfileForSource(
        { outputWidth: 1920, outputHeight: 1080 },
        source,
      ),
    ).toBe(false);
  });

  test("does not skip when source dimensions are unknown", () => {
    expect(
      shouldSkipProfileForSource(
        { outputWidth: 1920, outputHeight: 1080 },
        { videoWidth: null, videoHeight: null },
      ),
    ).toBe(false);
  });
});

describe("shouldSkipProfileForOrientation", () => {
  test("skips vertical profiles for a horizontal source", () => {
    const source = { videoWidth: 1920, videoHeight: 1080 };
    expect(
      shouldSkipProfileForOrientation(
        { outputWidth: 1080, outputHeight: 1920 },
        source,
      ),
    ).toBe(true);
  });

  test("skips horizontal profiles for a vertical source", () => {
    const source = { videoWidth: 1080, videoHeight: 1920 };
    expect(
      shouldSkipProfileForOrientation(
        { outputWidth: 1920, outputHeight: 1080 },
        source,
      ),
    ).toBe(true);
  });

  test("keeps profiles matching the source orientation", () => {
    const source = { videoWidth: 1920, videoHeight: 1080 };
    expect(
      shouldSkipProfileForOrientation(
        { outputWidth: 1280, outputHeight: 720 },
        source,
      ),
    ).toBe(false);
  });

  test("does not skip when source dimensions are unknown", () => {
    expect(
      shouldSkipProfileForOrientation(
        { outputWidth: 1080, outputHeight: 1920 },
        { videoWidth: null, videoHeight: null },
      ),
    ).toBe(false);
  });

  test("does not skip for a square source or square profile", () => {
    expect(
      shouldSkipProfileForOrientation(
        { outputWidth: 1080, outputHeight: 1920 },
        { videoWidth: 1000, videoHeight: 1000 },
      ),
    ).toBe(false);
    expect(
      shouldSkipProfileForOrientation(
        { outputWidth: 1000, outputHeight: 1000 },
        { videoWidth: 1920, videoHeight: 1080 },
      ),
    ).toBe(false);
  });
});
