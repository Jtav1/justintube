import { resolveLogLevel } from "../lib/logger.js";

describe("resolveLogLevel", () => {
  beforeEach(() => {
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    delete process.env.LOG_LEVEL;
  });

  test("defaults to debug when LOG_LEVEL is unset", () => {
    expect(resolveLogLevel()).toBe("debug");
  });

  test("passes through valid pino levels", () => {
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal", "silent"]) {
      process.env.LOG_LEVEL = level;
      expect(resolveLogLevel()).toBe(level);
    }
  });

  test("is case-insensitive", () => {
    process.env.LOG_LEVEL = "ERROR";
    expect(resolveLogLevel()).toBe("error");
  });

  test("falls back to debug for an unrecognized value", () => {
    process.env.LOG_LEVEL = "VERBOSE";
    expect(resolveLogLevel()).toBe("debug");
  });
});
