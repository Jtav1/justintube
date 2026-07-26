import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import {
  resetTables,
  seedContentTag,
  seedMetadata,
  seedUpload,
  seedUser,
  setupSchema,
} from "../helpers/db.js";

/**
 * Mocked Meilisearch index handle shared by every test in this file. `clearMocks`
 * (jest.config.js) resets call history before each test but keeps these
 * implementations, so no manual `mockClear()` calls are needed.
 */
const mockAddDocuments = jest.fn().mockResolvedValue({});
const mockDeleteDocument = jest.fn().mockResolvedValue({});
const mockSearch = jest.fn().mockResolvedValue({
  hits: [],
  page: 1,
  hitsPerPage: 20,
  totalHits: 0,
  totalPages: 0,
});
const mockIndexHandle = {
  addDocuments: mockAddDocuments,
  deleteDocument: mockDeleteDocument,
  search: mockSearch,
  updateSearchableAttributes: jest.fn().mockResolvedValue({}),
  updateFilterableAttributes: jest.fn().mockResolvedValue({}),
  updateSortableAttributes: jest.fn().mockResolvedValue({}),
};
const mockIndex = jest.fn(() => mockIndexHandle);
const mockCreateIndex = jest.fn().mockResolvedValue({});

// Must run before any (static or dynamic) import of "meilisearch" or
// lib/search.js — this suite dynamically imports lib/search.js in beforeAll
// below to satisfy that ordering under native ESM.
jest.unstable_mockModule("meilisearch", () => ({
  Meilisearch: jest.fn().mockImplementation(() => ({
    createIndex: mockCreateIndex,
    index: mockIndex,
  })),
}));

/**
 * Lower-level tests for lib/search.js: the ENABLE_ADVANCED_SEARCH gate and the
 * status/visibility eligibility logic that decides upsert vs. delete. The
 * "meilisearch" package is mocked, so these run without a live Meilisearch
 * instance.
 */
describe("Search indexing (lib/search.js)", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  describe("when ENABLE_ADVANCED_SEARCH is unset", () => {
    /** @type {typeof import("../../lib/search.js")} */
    let searchLib;

    beforeAll(async () => {
      delete process.env.ENABLE_ADVANCED_SEARCH;
      searchLib = await import("../../lib/search.js");
    });

    test("advancedSearchEnabled() is false", () => {
      expect(searchLib.advancedSearchEnabled()).toBe(false);
    });

    test("syncVideoIndex resolves without contacting Meilisearch", async () => {
      await expect(searchLib.syncVideoIndex(999)).resolves.toBeUndefined();
      expect(mockAddDocuments).not.toHaveBeenCalled();
      expect(mockDeleteDocument).not.toHaveBeenCalled();
    });

    test("removeVideoDocument resolves without contacting Meilisearch", async () => {
      await expect(searchLib.removeVideoDocument(999)).resolves.toBeUndefined();
      expect(mockDeleteDocument).not.toHaveBeenCalled();
    });
  });

  describe("when ENABLE_ADVANCED_SEARCH=true", () => {
    /** @type {typeof import("../../lib/search.js")} */
    let searchLib;

    beforeAll(async () => {
      process.env.ENABLE_ADVANCED_SEARCH = "true";
      process.env.MEILI_HOST = "http://meilisearch.test:7700";
      searchLib = await import("../../lib/search.js");
    });

    afterAll(() => {
      delete process.env.ENABLE_ADVANCED_SEARCH;
      delete process.env.MEILI_HOST;
    });

    test("advancedSearchEnabled() is true", () => {
      expect(searchLib.advancedSearchEnabled()).toBe(true);
    });

    test("syncVideoIndex upserts a ready + public video", async () => {
      const user = await seedUser({ username: "alice" });
      const upload = await seedUpload({ status: "ready", userId: user.id });
      await seedMetadata(upload.id, { title: "Cats", visibility: "public" });
      await seedContentTag(upload.id, { tag: "cats" });

      await searchLib.syncVideoIndex(upload.id);

      expect(mockAddDocuments).toHaveBeenCalledTimes(1);
      const [docs] = mockAddDocuments.mock.calls[0];
      expect(docs[0]).toMatchObject({
        id: upload.id,
        title: "Cats",
        visibility: "public",
        username: "alice",
        tags: ["cats"],
      });
      expect(mockDeleteDocument).not.toHaveBeenCalled();
    });

    test("syncVideoIndex deletes when the video is private", async () => {
      const upload = await seedUpload({ status: "ready" });
      await seedMetadata(upload.id, { visibility: "private" });

      await searchLib.syncVideoIndex(upload.id);

      expect(mockDeleteDocument).toHaveBeenCalledWith(upload.id);
      expect(mockAddDocuments).not.toHaveBeenCalled();
    });

    test("syncVideoIndex deletes when the video isn't ready yet", async () => {
      const upload = await seedUpload({ status: "processing" });
      await seedMetadata(upload.id, { visibility: "public" });

      await searchLib.syncVideoIndex(upload.id);

      expect(mockDeleteDocument).toHaveBeenCalledWith(upload.id);
      expect(mockAddDocuments).not.toHaveBeenCalled();
    });

    test("syncVideoIndex deletes when metadata doesn't exist yet", async () => {
      const upload = await seedUpload({ status: "ready" });

      await searchLib.syncVideoIndex(upload.id);

      expect(mockDeleteDocument).toHaveBeenCalledWith(upload.id);
      expect(mockAddDocuments).not.toHaveBeenCalled();
    });

    test("removeVideoDocument deletes directly by id", async () => {
      await searchLib.removeVideoDocument(42);
      expect(mockDeleteDocument).toHaveBeenCalledWith(42);
    });
  });
});
