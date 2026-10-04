import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { resetTables, seedUpload, setupSchema } from "../helpers/db.js";
import { runImportReconcile } from "../../lib/import-reconcile.js";
import { OriginalUpload } from "../../lib/models/index.js";

/**
 * Unit tests for the stale-import reconcile sweep: rolling back
 * ORIGINAL_UPLOADS placeholder rows left in status "downloading" by a
 * POST /videos/import whose fire-and-forget continueImport never finished
 * (e.g. webapi restarted mid-download).
 */
describe("runImportReconcile", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("rolls back a stale downloading placeholder row", async () => {
    const stale = await seedUpload({
      status: "downloading",
      storagePath: "",
      originalFilename: "",
      fileExtension: "",
      uploadedAt: new Date(Date.now() - 60 * 60_000),
    });

    const results = await runImportReconcile({ staleMinutes: 30 });

    expect(results).toEqual([{ action: "rolled_back", videoId: stale.videoId }]);
    expect(await OriginalUpload.findByPk(stale.id)).toBeNull();
  });

  test("leaves a recent downloading placeholder row alone", async () => {
    const recent = await seedUpload({
      status: "downloading",
      storagePath: "",
      originalFilename: "",
      fileExtension: "",
      uploadedAt: new Date(),
    });

    const results = await runImportReconcile({ staleMinutes: 30 });

    expect(results).toEqual([]);
    expect(await OriginalUpload.findByPk(recent.id)).not.toBeNull();
  });

  test("leaves uploads with a real storagePath alone, even if stuck in another status", async () => {
    const processing = await seedUpload({
      status: "processing",
      uploadedAt: new Date(Date.now() - 60 * 60_000),
    });

    const results = await runImportReconcile({ staleMinutes: 30 });

    expect(results).toEqual([]);
    expect(await OriginalUpload.findByPk(processing.id)).not.toBeNull();
  });
});
