import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from "@jest/globals";
import { OriginalUpload, User, UserPlaylist } from "../../lib/models/index.js";
import {
  resetTables,
  seedMetadata,
  seedPlaylist,
  seedUpload,
  seedUser,
  setupSchema,
} from "../helpers/db.js";

/**
 * Mocked Meilisearch index handle shared by every test in this file — same
 * shape/rationale as tests/db/search.test.js's mock.
 */
const mockAddDocuments = jest.fn().mockResolvedValue({});
const mockDeleteDocument = jest.fn().mockResolvedValue({});

/**
 * @returns {Promise<object> & {waitTask: () => Promise<object>}} A settings-update mock result.
 */
function mockSettingsUpdate() {
  return Object.assign(Promise.resolve({}), { waitTask: jest.fn().mockResolvedValue({}) });
}

const mockIndexHandle = {
  addDocuments: mockAddDocuments,
  deleteDocument: mockDeleteDocument,
  search: jest.fn().mockResolvedValue({ hits: [] }),
  updateSearchableAttributes: jest.fn().mockImplementation(mockSettingsUpdate),
  updateFilterableAttributes: jest.fn().mockImplementation(mockSettingsUpdate),
  updateSortableAttributes: jest.fn().mockImplementation(mockSettingsUpdate),
};
const mockIndex = jest.fn(() => mockIndexHandle);
const mockCreateIndex = jest.fn().mockResolvedValue({});

// Must run before any (static or dynamic) import of "meilisearch" or
// lib/search-reindex.js — this suite dynamically imports lib/search-reindex.js
// in beforeAll below to satisfy that ordering under native ESM.
jest.unstable_mockModule("meilisearch", () => ({
  Meilisearch: jest.fn().mockImplementation(() => ({
    createIndex: mockCreateIndex,
    index: mockIndex,
  })),
}));

/**
 * Tests for lib/search-reindex.js's nightly batch: `runSearchReindex()`
 * processes every `searchIndexStatus: "pending"` video/playlist/user into
 * Meilisearch and flips each to `"indexed"`. The "meilisearch" package is
 * mocked, so these run without a live Meilisearch instance.
 */
describe("Nightly search reindex (lib/search-reindex.js)", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  describe("when ENABLE_ADVANCED_SEARCH is unset", () => {
    /** @type {typeof import("../../lib/search-reindex.js")} */
    let searchReindex;

    beforeAll(async () => {
      delete process.env.ENABLE_ADVANCED_SEARCH;
      searchReindex = await import("../../lib/search-reindex.js");
    });

    test("runSearchReindex is a no-op", async () => {
      const upload = await seedUpload({ status: "ready" });
      await seedMetadata(upload.id, { title: "Untouched", visibility: "public" });

      await searchReindex.runSearchReindex();

      expect(mockAddDocuments).not.toHaveBeenCalled();
      const reloaded = await OriginalUpload.findByPk(upload.id);
      expect(reloaded.searchIndexStatus).toBe("pending");
    });
  });

  describe("when ENABLE_ADVANCED_SEARCH=true", () => {
    /** @type {typeof import("../../lib/search-reindex.js")} */
    let searchReindex;

    beforeAll(async () => {
      process.env.ENABLE_ADVANCED_SEARCH = "true";
      process.env.MEILI_HOST = "http://meilisearch.test:7700";
      searchReindex = await import("../../lib/search-reindex.js");
    });

    afterAll(() => {
      delete process.env.ENABLE_ADVANCED_SEARCH;
      delete process.env.MEILI_HOST;
    });

    test("syncs a pending public video into Meilisearch and marks it indexed", async () => {
      // Note: seedUser itself creates a row that defaults to
      // searchIndexStatus: "pending" too, so it's also reindexed in this run
      // (as its own document) — assertions below key off the video's id
      // specifically rather than a total call count.
      const user = await seedUser({ username: "alice" });
      const upload = await seedUpload({ status: "ready", userId: user.id });
      await seedMetadata(upload.id, { title: "Cats", visibility: "public" });
      // New rows default to searchIndexStatus: "pending" — no explicit sync call needed.

      await searchReindex.runSearchReindex();

      const videoCall = mockAddDocuments.mock.calls.find(([docs]) => docs[0]?.id === upload.id);
      expect(videoCall).toBeDefined();
      expect(videoCall[0][0]).toMatchObject({ title: "Cats" });
      const reloaded = await OriginalUpload.findByPk(upload.id);
      expect(reloaded.searchIndexStatus).toBe("indexed");
    });

    test("leaves a pending video as pending when its sync throws, for retry on the next run", async () => {
      const upload = await seedUpload({ status: "ready" });
      await seedMetadata(upload.id, { title: "Flaky", visibility: "public" });
      mockAddDocuments.mockRejectedValueOnce(new Error("network blip"));

      await searchReindex.runSearchReindex();

      const reloaded = await OriginalUpload.findByPk(upload.id);
      expect(reloaded.searchIndexStatus).toBe("pending");
    });

    test("does not reprocess an already-indexed video", async () => {
      const upload = await seedUpload({ status: "ready" });
      await seedMetadata(upload.id, { title: "Already Done", visibility: "public" });
      await OriginalUpload.update({ searchIndexStatus: "indexed" }, { where: { id: upload.id } });

      await searchReindex.runSearchReindex();

      const videoCall = mockAddDocuments.mock.calls.find(([docs]) => docs[0]?.id === upload.id);
      expect(videoCall).toBeUndefined();
    });

    test("syncs a pending public playlist and marks it indexed", async () => {
      // Note: seedUser (the playlist owner) is itself reindexed too in this
      // run — see the comment on the video test above.
      const owner = await seedUser({ username: "playlist_owner" });
      const playlist = await seedPlaylist({
        userId: owner.id,
        title: "Great Trips",
        visibility: "public",
      });

      await searchReindex.runSearchReindex();

      const playlistCall = mockAddDocuments.mock.calls.find(
        ([docs]) => docs[0]?.id === playlist.id,
      );
      expect(playlistCall).toBeDefined();
      expect(playlistCall[0][0]).toMatchObject({ title: "Great Trips" });
      const reloaded = await UserPlaylist.findByPk(playlist.id);
      expect(reloaded.searchIndexStatus).toBe("indexed");
    });

    test("syncs a pending non-locked user and marks it indexed", async () => {
      const user = await seedUser({ username: "findable_user" });

      await searchReindex.runSearchReindex();

      const userCall = mockAddDocuments.mock.calls.find(([docs]) => docs[0]?.id === user.id);
      expect(userCall).toBeDefined();
      const reloaded = await User.findByPk(user.id);
      expect(reloaded.searchIndexStatus).toBe("indexed");
    });
  });
});
