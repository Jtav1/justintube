import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  TranscodeValidationError,
  originalDir,
  resolveNormalizedOutputPath,
  resolveOriginalInputPath,
  resolveThumbnailInputPath,
  resolveThumbnailOutputPath,
  resolveTranscodedOutputPath,
  thumbnailsDir,
  transcodedDir,
} from "../lib/media-paths.js";

// Distinctive test-only subfolder segments, cleaned up after each test so
// these don't pollute the real (gitignored) local media/ directory shared by
// other tests that import this module.
const TEST_SEGMENTS = ["987654", "_unowned"];

afterEach(() => {
  for (const dir of [originalDir, transcodedDir, thumbnailsDir]) {
    for (const segment of TEST_SEGMENTS) {
      rmSync(join(dir, segment), { recursive: true, force: true });
    }
  }
});

describe("resolveOriginalInputPath", () => {
  test("resolves a file under a userId subfolder without creating anything", () => {
    expect(existsSync(join(originalDir, "987654"))).toBe(false);
    expect(() => resolveOriginalInputPath("987654/missing.mp4")).toThrow(
      TranscodeValidationError,
    );
    // Deliberately does not mkdir a subfolder just to look for a file in it.
    expect(existsSync(join(originalDir, "987654"))).toBe(false);
  });
});

describe("output path resolvers create a not-yet-existing subfolder on demand", () => {
  test("resolveTranscodedOutputPath mkdirs a new userId subfolder under transcoded/", () => {
    expect(existsSync(join(transcodedDir, "987654"))).toBe(false);
    const outPath = resolveTranscodedOutputPath("987654/abc-uuid.mp4");
    expect(outPath).toBe(join(transcodedDir, "987654", "abc-uuid.mp4"));
    expect(existsSync(join(transcodedDir, "987654"))).toBe(true);
  });

  test("resolveThumbnailOutputPath mkdirs a new _unowned subfolder under thumbnails/", () => {
    expect(existsSync(join(thumbnailsDir, "_unowned"))).toBe(false);
    const outPath = resolveThumbnailOutputPath("_unowned/abc.webp");
    expect(outPath).toBe(join(thumbnailsDir, "_unowned", "abc.webp"));
    expect(existsSync(join(thumbnailsDir, "_unowned"))).toBe(true);
  });

  test("resolveNormalizedOutputPath mkdirs a new userId subfolder under original/", () => {
    expect(existsSync(join(originalDir, "987654"))).toBe(false);
    const outPath = resolveNormalizedOutputPath("987654/new-uuid.mp4");
    expect(outPath).toBe(join(originalDir, "987654", "new-uuid.mp4"));
    expect(existsSync(join(originalDir, "987654"))).toBe(true);
  });

  test("output resolvers still work for a plain basename (no subfolder)", () => {
    const outPath = resolveTranscodedOutputPath("abc-uuid.mp4");
    expect(outPath).toBe(join(transcodedDir, "abc-uuid.mp4"));
  });

  test("output resolvers reject an invalid subfolder segment", () => {
    expect(() => resolveTranscodedOutputPath("not-a-userid/abc.mp4")).toThrow(
      TranscodeValidationError,
    );
    expect(() => resolveThumbnailOutputPath("../abc.webp")).toThrow(
      TranscodeValidationError,
    );
  });
});

describe("resolveOriginalInputPath finds a file placed under a userId subfolder", () => {
  test("resolves successfully once the file actually exists", () => {
    const dir = join(originalDir, "987654");
    const filePath = join(dir, "real.mp4");
    resolveNormalizedOutputPath("987654/placeholder.mp4"); // mkdirs the subfolder as a side effect
    writeFileSync(filePath, "not a real video, just bytes for the test");

    expect(resolveOriginalInputPath("987654/real.mp4")).toBe(filePath);
  });
});

describe("resolveThumbnailInputPath", () => {
  test("resolves a thumbnail image under a userId subfolder without creating anything", () => {
    expect(existsSync(join(thumbnailsDir, "987654"))).toBe(false);
    expect(() => resolveThumbnailInputPath("987654/missing.jpg")).toThrow(
      TranscodeValidationError,
    );
    expect(existsSync(join(thumbnailsDir, "987654"))).toBe(false);
  });

  test("resolves successfully once the thumbnail file actually exists", () => {
    const dir = join(thumbnailsDir, "987654");
    const filePath = join(dir, "cover.jpg");
    resolveThumbnailOutputPath("987654/placeholder.webp"); // mkdirs the subfolder as a side effect
    writeFileSync(filePath, "not a real image, just bytes for the test");

    expect(resolveThumbnailInputPath("987654/cover.jpg")).toBe(filePath);
  });
});
