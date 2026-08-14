import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import {
  getHashReconcileConfig,
  runHashReconcile,
} from "../../lib/hash-reconcile.js";

/**
 * Unit tests for the nightly duplicate-hash reconcile: it asks the
 * processing service to retry every failed content-hash job it still has
 * queued in Redis, gated entirely on ENABLE_DUPLICATE_UPLOAD_DETECTION.
 */
describe("runHashReconcile", () => {
  /** @type {typeof fetch | undefined} */
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.ENABLE_DUPLICATE_UPLOAD_DETECTION;
  });

  test("is a no-op when duplicate-upload detection is disabled, without calling processing", async () => {
    delete process.env.ENABLE_DUPLICATE_UPLOAD_DETECTION;
    globalThis.fetch = jest.fn();

    const result = await runHashReconcile();

    expect(result).toEqual({ retried: [], discarded: [], failed: [] });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("retries failed hash jobs via the processing service when enabled", async () => {
    process.env.ENABLE_DUPLICATE_UPLOAD_DETECTION = "true";
    globalThis.fetch = jest.fn(async (url) => {
      expect(String(url)).toContain("/transcode/retry-failed-hashes");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          retried: ["hash-abc123"],
          discarded: [],
          failed: [],
        }),
      };
    });

    const result = await runHashReconcile();

    expect(result).toEqual({ retried: ["hash-abc123"], discarded: [], failed: [] });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("surfaces jobs discarded after reaching the run cap", async () => {
    process.env.ENABLE_DUPLICATE_UPLOAD_DETECTION = "true";
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        retried: [],
        discarded: ["hash-maxed-out"],
        failed: [],
      }),
    }));

    const result = await runHashReconcile();

    expect(result).toEqual({ retried: [], discarded: ["hash-maxed-out"], failed: [] });
  });

  test("surfaces per-job retry failures without throwing", async () => {
    process.env.ENABLE_DUPLICATE_UPLOAD_DETECTION = "true";
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        retried: [],
        discarded: [],
        failed: [{ jobId: "hash-bad", error: "job is not in a failed state" }],
      }),
    }));

    const result = await runHashReconcile();

    expect(result).toEqual({
      retried: [],
      discarded: [],
      failed: [{ jobId: "hash-bad", error: "job is not in a failed state" }],
    });
  });

  test("returns empty results (not a throw) when the processing call itself fails", async () => {
    process.env.ENABLE_DUPLICATE_UPLOAD_DETECTION = "true";
    globalThis.fetch = jest.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });

    const result = await runHashReconcile();

    expect(result).toEqual({ retried: [], discarded: [], failed: [] });
  });
});

describe("getHashReconcileConfig", () => {
  afterEach(() => {
    delete process.env.DUPLICATE_HASH_RECONCILE_ENABLED;
    delete process.env.DUPLICATE_HASH_RECONCILE_CRON;
  });

  test("defaults to enabled, nightly at 3am", () => {
    delete process.env.DUPLICATE_HASH_RECONCILE_ENABLED;
    delete process.env.DUPLICATE_HASH_RECONCILE_CRON;

    expect(getHashReconcileConfig()).toEqual({ cron: "0 3 * * *", enabled: true });
  });

  test("honors overrides", () => {
    process.env.DUPLICATE_HASH_RECONCILE_ENABLED = "false";
    process.env.DUPLICATE_HASH_RECONCILE_CRON = "*/10 * * * *";

    expect(getHashReconcileConfig()).toEqual({
      cron: "*/10 * * * *",
      enabled: false,
    });
  });
});
