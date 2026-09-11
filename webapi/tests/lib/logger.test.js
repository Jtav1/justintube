import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { resolveLogLevel } from "../../lib/logger.js";

describe("resolveLogLevel", () => {
  beforeEach(() => {
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    delete process.env.LOG_LEVEL;
  });

  it("defaults to debug when LOG_LEVEL is unset", () => {
    expect(resolveLogLevel()).toBe("debug");
  });

  it.each(["trace", "debug", "info", "warn", "error", "fatal", "silent"])(
    "passes through a valid pino level: %s",
    (level) => {
      process.env.LOG_LEVEL = level;
      expect(resolveLogLevel()).toBe(level);
    },
  );

  it("is case-insensitive", () => {
    process.env.LOG_LEVEL = "ERROR";
    expect(resolveLogLevel()).toBe("error");
  });

  it("falls back to debug for an unrecognized value", () => {
    process.env.LOG_LEVEL = "VERBOSE";
    expect(resolveLogLevel()).toBe("debug");
  });
});
