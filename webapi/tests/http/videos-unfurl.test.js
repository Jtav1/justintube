import { afterEach, beforeAll, beforeEach, describe, expect, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedFileVersion,
  seedMetadata,
  seedUpload,
  seedUser,
  setupSchema,
} from "../helpers/db.js";

describe("GET /videos/{id}/unfurl (getVideoUnfurl) and /videos/{id}/player (getVideoPlayer)", () => {
  let client;
  let savedPort;
  let savedPublicApiUrl;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  beforeEach(() => {
    // publicApiOrigin()/renderUnfurlHtml() read these at request time -
    // pin them so assertions on absolute URLs are deterministic regardless
    // of the ambient shell environment.
    savedPort = process.env.PORT;
    savedPublicApiUrl = process.env.PUBLIC_API_URL;
    delete process.env.PORT;
    delete process.env.PUBLIC_API_URL;
  });

  afterEach(async () => {
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
    if (savedPublicApiUrl === undefined) delete process.env.PUBLIC_API_URL;
    else process.env.PUBLIC_API_URL = savedPublicApiUrl;
    await resetTables();
  });

  describe("GET /videos/:id/unfurl", () => {
    test("returns 200 HTML with og:title and og:video pointing at the smallest complete rendition", async () => {
      const upload = await seedUpload({ mediaType: "video" });
      await seedMetadata(upload.id, { title: "My Video", visibility: "public" });
      await seedFileVersion(upload.id, {
        status: "complete",
        resolution: "1080p",
        videoHeight: 1080,
        videoWidth: 1920,
      });
      await seedFileVersion(upload.id, {
        status: "complete",
        resolution: "240p",
        videoHeight: 240,
        videoWidth: 426,
      });
      await seedFileVersion(upload.id, {
        status: "complete",
        resolution: "720p",
        videoHeight: 720,
        videoWidth: 1280,
      });

      const res = await client.get(`/api/v1/videos/${upload.id}/unfurl`);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.text).toContain('property="og:title" content="My Video"');
      expect(res.text).toContain(
        `property="og:video" content="http://localhost:3000/api/v1/videos/${upload.id}/stream?quality=240p"`,
      );
      expect(res.text).toContain('property="og:video:width" content="426"');
      expect(res.text).toContain('property="og:video:height" content="240"');
      // Discord (and most unfurlers) can't show an inline video player and a
      // description at once, so a video-embedding page omits og:description.
      expect(res.text).not.toContain('property="og:description"');
      expect(res.text).not.toContain('name="twitter:description"');
    });

    test("picks the original upload when it is smaller than every complete FileVersion", async () => {
      const upload = await seedUpload({
        mediaType: "video",
        videoWidth: 320,
        videoHeight: 180,
      });
      await seedMetadata(upload.id, { title: "Tiny original", visibility: "public" });
      await seedFileVersion(upload.id, {
        status: "complete",
        resolution: "720p",
        videoHeight: 720,
        videoWidth: 1280,
      });

      const res = await client.get(`/api/v1/videos/${upload.id}/unfurl`);

      expect(res.status).toBe(200);
      expect(res.text).toContain(
        `property="og:video" content="http://localhost:3000/api/v1/videos/${upload.id}/stream?quality=original"`,
      );
    });

    test("omits og:video for an audio-only upload", async () => {
      const upload = await seedUpload({ mediaType: "audio" });
      await seedMetadata(upload.id, { title: "Podcast ep", visibility: "public" });
      await seedFileVersion(upload.id, { status: "complete", resolution: "240p" });

      const res = await client.get(`/api/v1/videos/${upload.id}/unfurl`);

      expect(res.status).toBe(200);
      expect(res.text).not.toContain('property="og:video"');
      // Not embeddable as a video player, so it's a non-video-player page:
      // gets a plain "Justintube - <title>" description instead.
      expect(res.text).toContain(
        'property="og:description" content="Justintube - Podcast ep"',
      );
      expect(res.text).toContain(
        'name="twitter:description" content="Justintube - Podcast ep"',
      );
    });

    test("returns the generic masked fallback for a private video without a grant", async () => {
      const owner = await seedUser();
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id, { title: "Secret plans", visibility: "private" });

      const res = await client.get(`/api/v1/videos/${upload.id}/unfurl`);

      expect(res.status).toBe(404);
      expect(res.text).not.toContain("Secret plans");
      expect(res.text).toContain("Justintube");
    });

    test("returns the same generic fallback body for a nonexistent video as for a forbidden one", async () => {
      const missing = await client.get("/api/v1/videos/999999/unfurl");
      const owner = await seedUser();
      const upload = await seedUpload({ userId: owner.id });
      await seedMetadata(upload.id, { visibility: "private" });
      const forbidden = await client.get(`/api/v1/videos/${upload.id}/unfurl`);

      expect(missing.status).toBe(404);
      expect(forbidden.status).toBe(404);
      expect(missing.text).toBe(forbidden.text);
    });

    test("escapes a title containing a script tag", async () => {
      const upload = await seedUpload();
      await seedMetadata(upload.id, {
        title: "<script>alert(1)</script>",
        visibility: "public",
      });

      const res = await client.get(`/api/v1/videos/${upload.id}/unfurl`);

      expect(res.status).toBe(200);
      expect(res.text).not.toContain("<script>alert(1)</script>");
      expect(res.text).toContain("&lt;script&gt;");
    });

    test("emits twitter:card=player only when PUBLIC_API_URL is HTTPS", async () => {
      const upload = await seedUpload({ mediaType: "video" });
      await seedMetadata(upload.id, { title: "Secure video", visibility: "public" });
      await seedFileVersion(upload.id, {
        status: "complete",
        resolution: "240p",
        videoHeight: 240,
        videoWidth: 426,
      });

      const httpRes = await client.get(`/api/v1/videos/${upload.id}/unfurl`);
      expect(httpRes.text).toContain(
        'name="twitter:card" content="summary_large_image"',
      );
      expect(httpRes.text).not.toContain('name="twitter:card" content="player"');

      process.env.PUBLIC_API_URL = "https://example.test";
      const httpsRes = await client.get(`/api/v1/videos/${upload.id}/unfurl`);
      expect(httpsRes.text).toContain('name="twitter:card" content="player"');
      expect(httpsRes.text).toContain(
        `name="twitter:player" content="https://example.test/api/v1/videos/${upload.id}/player"`,
      );
    });
  });

  describe("GET /videos/:id/player", () => {
    test("returns an embeddable HTML page for the smallest rendition with framing headers", async () => {
      const upload = await seedUpload({ mediaType: "video" });
      await seedMetadata(upload.id, { title: "Playable", visibility: "public" });
      await seedFileVersion(upload.id, {
        status: "complete",
        resolution: "240p",
        videoHeight: 240,
        videoWidth: 426,
      });

      const res = await client.get(`/api/v1/videos/${upload.id}/player`);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.headers["x-frame-options"]).toBeUndefined();
      expect(res.headers["content-security-policy"]).toMatch(/frame-ancestors/);
      expect(res.text).toContain(
        `src="http://localhost:3000/api/v1/videos/${upload.id}/stream?quality=240p"`,
      );
    });

    test("404s for an audio-only upload", async () => {
      const upload = await seedUpload({ mediaType: "audio" });
      await seedMetadata(upload.id, { title: "Podcast ep", visibility: "public" });

      const res = await client.get(`/api/v1/videos/${upload.id}/player`);

      expect(res.status).toBe(404);
    });

    test("returns the same generic fallback body for a nonexistent video as for a forbidden one", async () => {
      const missing = await client.get("/api/v1/videos/999999/player");
      const owner = await seedUser();
      const upload = await seedUpload({ userId: owner.id, mediaType: "video" });
      await seedMetadata(upload.id, { visibility: "private" });
      const forbidden = await client.get(`/api/v1/videos/${upload.id}/player`);

      expect(missing.status).toBe(404);
      expect(forbidden.status).toBe(404);
      expect(missing.text).toBe(forbidden.text);
    });
  });
});
