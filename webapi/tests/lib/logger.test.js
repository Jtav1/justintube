import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { configureLogging } from "../../lib/logger.js";

describe("configureLogging", () => {
  const original = {
    log: console.log,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };

  beforeEach(() => {
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    delete process.env.LOG_LEVEL;
    console.log = original.log;
    console.debug = original.debug;
    console.warn = original.warn;
    console.error = original.error;
  });

  it("leaves console methods untouched when LOG_LEVEL is unset (default DEBUG)", () => {
    configureLogging();
    expect(console.log).toBe(original.log);
    expect(console.debug).toBe(original.debug);
    expect(console.warn).toBe(original.warn);
    expect(console.error).toBe(original.error);
  });

  it("leaves console methods untouched when LOG_LEVEL=DEBUG", () => {
    process.env.LOG_LEVEL = "DEBUG";
    configureLogging();
    expect(console.log).toBe(original.log);
    expect(console.error).toBe(original.error);
  });

  it("silences log/debug/warn but keeps error when LOG_LEVEL=ERROR", () => {
    process.env.LOG_LEVEL = "ERROR";
    configureLogging();
    expect(console.log).not.toBe(original.log);
    expect(console.debug).not.toBe(original.debug);
    expect(console.warn).not.toBe(original.warn);
    expect(console.error).toBe(original.error);
  });

  it("silences everything when LOG_LEVEL=NONE", () => {
    process.env.LOG_LEVEL = "NONE";
    configureLogging();
    expect(console.log).not.toBe(original.log);
    expect(console.debug).not.toBe(original.debug);
    expect(console.warn).not.toBe(original.warn);
    expect(console.error).not.toBe(original.error);
  });

  it("is case-insensitive", () => {
    process.env.LOG_LEVEL = "error";
    configureLogging();
    expect(console.log).not.toBe(original.log);
    expect(console.error).toBe(original.error);
  });

  it("falls back to DEBUG behavior for an unrecognized value", () => {
    process.env.LOG_LEVEL = "VERBOSE";
    configureLogging();
    expect(console.log).toBe(original.log);
    expect(console.error).toBe(original.error);
  });
});
