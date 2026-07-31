import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import {
  removeVideoDocument,
  resetBasicIndexForTests,
  searchVideos,
  suggestVideos,
  syncVideoIndex,
} from "../../lib/search.js";
import {
  resetTables,
  seedContentTag,
  seedMetadata,
  seedUpload,
  seedUser,
  setupSchema,
} from "../helpers/db.js";

/**
 * Tests for the default, in-process (MiniSearch) search backend
 * (`lib/search/basic.js`), exercised through the public dispatcher
 * (`lib/search.js`) with `ENABLE_ADVANCED_SEARCH` left unset — mirrors the
 * structure of `tests/db/search.test.js`'s Meilisearch coverage, but against
 * a real (unmocked) in-process index. No live search backend is required.
 */
describe("Search indexing (lib/search/basic.js, the default backend)", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    // resetTables() wipes rows directly, bypassing the sync hooks that would
    // otherwise keep the in-process index consistent — reset it too so tests
    // in this file don't see stale documents from earlier tests.
    await resetTables();
    resetBasicIndexForTests();
  });

  test("syncVideoIndex upserts a ready + public video, findable by title", async () => {
    const user = await seedUser({ username: "alice" });
    const upload = await seedUpload({ status: "ready", userId: user.id });
    await seedMetadata(upload.id, { title: "Cats of the Internet", visibility: "public" });
    await seedContentTag(upload.id, { tag: "cats" });

    await syncVideoIndex(upload.id);

    const result = await searchVideos({ q: "cats", page: 1, limit: 20 });
    expect(result.hits.map((h) => h.id)).toContain(upload.id);
    const hit = result.hits.find((h) => h.id === upload.id);
    expect(hit).toMatchObject({ title: "Cats of the Internet", username: "alice", tags: ["cats"] });
  });

  test("syncVideoIndex excludes a private video", async () => {
    const upload = await seedUpload({ status: "ready" });
    await seedMetadata(upload.id, { title: "Secret Clip", visibility: "private" });

    await syncVideoIndex(upload.id);

    const result = await searchVideos({ q: "Secret", page: 1, limit: 20 });
    expect(result.hits.map((h) => h.id)).not.toContain(upload.id);
  });

  test("syncVideoIndex includes a public video even if it never went through transcoding (status isn't 'ready')", async () => {
    const upload = await seedUpload({ status: "processing" });
    await seedMetadata(upload.id, { title: "Still Processing", visibility: "public" });

    await syncVideoIndex(upload.id);

    const result = await searchVideos({ q: "Processing", page: 1, limit: 20 });
    expect(result.hits.map((h) => h.id)).toContain(upload.id);
  });

  test("syncVideoIndex excludes a video with no metadata yet", async () => {
    const upload = await seedUpload({ status: "ready" });

    await expect(syncVideoIndex(upload.id)).resolves.toBeUndefined();

    const result = await searchVideos({ page: 1, limit: 20 });
    expect(result.hits.map((h) => h.id)).not.toContain(upload.id);
  });

  test("removeVideoDocument removes a previously-indexed video", async () => {
    const upload = await seedUpload({ status: "ready" });
    await seedMetadata(upload.id, { title: "Removable", visibility: "public" });
    await syncVideoIndex(upload.id);
    expect((await searchVideos({ q: "Removable", page: 1, limit: 20 })).hits.map((h) => h.id)).toContain(
      upload.id,
    );

    await removeVideoDocument(upload.id);

    const result = await searchVideos({ q: "Removable", page: 1, limit: 20 });
    expect(result.hits.map((h) => h.id)).not.toContain(upload.id);
  });

  test("searchVideos with no query browses all eligible videos", async () => {
    const uploadA = await seedUpload({ status: "ready" });
    await seedMetadata(uploadA.id, { title: "First Video", visibility: "public" });
    const uploadB = await seedUpload({ status: "ready" });
    await seedMetadata(uploadB.id, { title: "Second Video", visibility: "public" });
    await syncVideoIndex(uploadA.id);
    await syncVideoIndex(uploadB.id);

    const result = await searchVideos({ page: 1, limit: 20 });

    expect(result.hits.map((h) => h.id).sort()).toEqual([uploadA.id, uploadB.id].sort());
    expect(result.totalHits).toBe(2);
  });

  test("searchVideos filters by tags (AND across all requested tags)", async () => {
    const uploadA = await seedUpload({ status: "ready" });
    await seedMetadata(uploadA.id, { title: "Tagged A", visibility: "public" });
    await seedContentTag(uploadA.id, { tag: "cats" });
    await seedContentTag(uploadA.id, { tag: "funny" });
    const uploadB = await seedUpload({ status: "ready" });
    await seedMetadata(uploadB.id, { title: "Tagged B", visibility: "public" });
    await seedContentTag(uploadB.id, { tag: "cats" });
    await syncVideoIndex(uploadA.id);
    await syncVideoIndex(uploadB.id);

    const result = await searchVideos({ tags: ["cats", "funny"], page: 1, limit: 20 });

    expect(result.hits.map((h) => h.id)).toEqual([uploadA.id]);
  });

  test("searchVideos filters by exact uploader username", async () => {
    const alice = await seedUser({ username: "alice" });
    const bob = await seedUser({ username: "bob" });
    const uploadA = await seedUpload({ status: "ready", userId: alice.id });
    await seedMetadata(uploadA.id, { title: "Alice video", visibility: "public" });
    const uploadB = await seedUpload({ status: "ready", userId: bob.id });
    await seedMetadata(uploadB.id, { title: "Bob video", visibility: "public" });
    await syncVideoIndex(uploadA.id);
    await syncVideoIndex(uploadB.id);

    const result = await searchVideos({ username: "alice", page: 1, limit: 20 });

    expect(result.hits.map((h) => h.id)).toEqual([uploadA.id]);
  });

  test("searchVideos sorts by newest/oldest/views on request", async () => {
    // SQLite's CURRENT_TIMESTAMP default has only second-level precision, so
    // two rows seeded back-to-back can tie — set createdAt explicitly to keep
    // the ordering assertion deterministic regardless of test execution speed.
    const uploadOld = await seedUpload({ status: "ready" });
    await seedMetadata(uploadOld.id, {
      title: "Old",
      visibility: "public",
      viewCount: 1,
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const uploadNew = await seedUpload({ status: "ready" });
    await seedMetadata(uploadNew.id, {
      title: "New",
      visibility: "public",
      viewCount: 100,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    });
    await syncVideoIndex(uploadOld.id);
    await syncVideoIndex(uploadNew.id);

    const byViews = await searchVideos({ sort: "viewCount:desc", page: 1, limit: 20 });
    expect(byViews.hits[0].id).toBe(uploadNew.id);

    const oldest = await searchVideos({ sort: "createdAt:asc", page: 1, limit: 20 });
    expect(oldest.hits[0].id).toBe(uploadOld.id);
  });

  test("searchVideos paginates and reports totalHits/totalPages", async () => {
    for (let i = 0; i < 5; i += 1) {
      const upload = await seedUpload({ status: "ready" });
      await seedMetadata(upload.id, { title: `Page item ${i}`, visibility: "public" });
      await syncVideoIndex(upload.id);
    }

    const page1 = await searchVideos({ page: 1, limit: 2 });
    expect(page1.hits).toHaveLength(2);
    expect(page1.totalHits).toBe(5);
    expect(page1.totalPages).toBe(3);

    const page3 = await searchVideos({ page: 3, limit: 2 });
    expect(page3.hits).toHaveLength(1);
  });

  test("suggestVideos returns matches for a prefix, and nothing for an empty query", async () => {
    const upload = await seedUpload({ status: "ready" });
    await seedMetadata(upload.id, { title: "Suggestible Video", visibility: "public" });
    await syncVideoIndex(upload.id);

    const suggestions = await suggestVideos("Sugg", 8);
    expect(suggestions.hits.map((h) => h.id)).toContain(upload.id);

    const empty = await suggestVideos("", 8);
    expect(empty.hits).toEqual([]);
  });
});
