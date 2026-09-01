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

    test("embeds an audio upload via og:video (Discord's only inline-audio mechanism), plus og:audio", async () => {
      const upload = await seedUpload({ mediaType: "audio" });
      await seedMetadata(upload.id, { title: "Podcast ep", visibility: "public" });
      await seedFileVersion(upload.id, {
        status: "complete",
        resolution: "240p",
        mimeType: "audio/mpeg",
      });

      const res = await client.get(`/api/v1/videos/${upload.id}/unfurl`);

      expect(res.status).toBe(200);
      expect(res.text).toContain(
        `property="og:video" content="http://localhost:3000/api/v1/videos/${upload.id}/stream?quality=240p"`,
      );
      expect(res.text).toContain('property="og:video:type" content="audio/mpeg"');
      // Audio renditions have no natural dimensions, but Discord requires
      // og:video:width/height to be present to activate the embed at all.
      expect(res.text).toContain('property="og:video:width" content="480"');
      expect(res.text).toContain('property="og:video:height" content="80"');
      // Also included for the few other unfurlers that do honor og:audio.
      expect(res.text).toContain(
        `property="og:audio" content="http://localhost:3000/api/v1/videos/${upload.id}/stream?quality=240p"`,
      );
      expect(res.text).toContain('property="og:audio:type" content="audio/mpeg"');
      expect(res.text).toContain('property="og:type" content="music.song"');
      // Embeds a player, so no description, matching the video case.
      expect(res.text).not.toContain('property="og:description"');
      expect(res.text).not.toContain('name="twitter:description"');
    });

    test("prefers the muxed embed video over the raw audio stream for og:video once one has been generated", async () => {
      const upload = await seedUpload({
        mediaType: "audio",
        embedVideoStoragePath: "transcoded/abc-embed.mp4",
        embedVideoWidth: 480,
        embedVideoHeight: 480,
      });
      await seedMetadata(upload.id, { title: "Podcast with cover art", visibility: "public" });
      await seedFileVersion(upload.id, {
        status: "complete",
        resolution: "240p",
        mimeType: "audio/mpeg",
      });

      const res = await client.get(`/api/v1/videos/${upload.id}/unfurl`);

      expect(res.status).toBe(200);
      // og:video now points at the real muxed video, not the raw audio stream.
      expect(res.text).toContain(
        `property="og:video" content="http://localhost:3000/api/v1/videos/${upload.id}/embed-video"`,
      );
      expect(res.text).toContain('property="og:video:type" content="video/mp4"');
      expect(res.text).toContain('property="og:video:width" content="480"');
      expect(res.text).toContain('property="og:video:height" content="480"');
      // og:audio still points at the real audio stream, never the embed video.
      expect(res.text).toContain(
        `property="og:audio" content="http://localhost:3000/api/v1/videos/${upload.id}/stream?quality=240p"`,
      );
      expect(res.text).toContain('property="og:audio:type" content="audio/mpeg"');
    });

    test("falls back to the raw audio stream for og:video when no embed video has been generated yet", async () => {
      const upload = await seedUpload({ mediaType: "audio" });
      await seedMetadata(upload.id, { title: "Podcast without art", visibility: "public" });
      await seedFileVersion(upload.id, {
        status: "complete",
        resolution: "240p",
        mimeType: "audio/mpeg",
      });

      const res = await client.get(`/api/v1/videos/${upload.id}/unfurl`);

      expect(res.status).toBe(200);
      expect(res.text).toContain(
        `property="og:video" content="http://localhost:3000/api/v1/videos/${upload.id}/stream?quality=240p"`,
      );
      expect(res.text).toContain('property="og:video:width" content="480"');
      expect(res.text).toContain('property="og:video:height" content="80"');
    });

    test("emits og:image (the speaker-icon placeholder) for an audio upload with no real thumbnail", async () => {
      const upload = await seedUpload({ mediaType: "audio" });
      await seedMetadata(upload.id, { title: "Podcast without art", visibility: "public" });
      await seedFileVersion(upload.id, { status: "complete", resolution: "240p" });

      const res = await client.get(`/api/v1/videos/${upload.id}/unfurl`);

      expect(res.status).toBe(200);
      expect(res.text).toContain(
        `property="og:image" content="http://localhost:3000/api/v1/videos/${upload.id}/thumbnail"`,
      );
    });

    test("omits og:image for a video upload with no thumbnail (no placeholder fallback)", async () => {
      const upload = await seedUpload({ mediaType: "video" });
      await seedMetadata(upload.id, { title: "Video without thumbnail", visibility: "public" });
      await seedFileVersion(upload.id, { status: "complete", resolution: "240p" });

      const res = await client.get(`/api/v1/videos/${upload.id}/unfurl`);

      expect(res.status).toBe(200);
      expect(res.text).not.toContain('property="og:image"');
    });

    test("uses the embed video for a mediaType:video upload the probe confirmed has no real video stream", async () => {
      // e.g. an audio-only file someone saved with a .mp4 extension -
      // mediaType alone would wrongly treat this as a real video and point
      // og:video at its (video-less) raw stream instead of the muxed embed.
      const upload = await seedUpload({
        mediaType: "video",
        hasVideoStream: false,
        embedVideoStoragePath: "transcoded/mislabeled-embed.mp4",
        embedVideoWidth: 480,
        embedVideoHeight: 480,
      });
      await seedMetadata(upload.id, { title: "Mislabeled audio file", visibility: "public" });
      await seedFileVersion(upload.id, { status: "complete", resolution: "240p" });

      const res = await client.get(`/api/v1/videos/${upload.id}/unfurl`);

      expect(res.status).toBe(200);
      expect(res.text).toContain(
        `property="og:video" content="http://localhost:3000/api/v1/videos/${upload.id}/embed-video"`,
      );
      expect(res.text).toContain('property="og:video:type" content="video/mp4"');
      expect(res.text).toContain(
        `property="og:image" content="http://localhost:3000/api/v1/videos/${upload.id}/thumbnail"`,
      );
    });

    test("emits twitter:card=player for an audio upload only when PUBLIC_API_URL is HTTPS", async () => {
      const upload = await seedUpload({ mediaType: "audio" });
      await seedMetadata(upload.id, { title: "Secure podcast", visibility: "public" });
      await seedFileVersion(upload.id, {
        status: "complete",
        resolution: "240p",
        mimeType: "audio/mpeg",
      });

      process.env.PUBLIC_API_URL = "https://example.test";
      const res = await client.get(`/api/v1/videos/${upload.id}/unfurl`);

      expect(res.text).toContain('name="twitter:card" content="player"');
      expect(res.text).toContain(
        `name="twitter:player" content="https://example.test/api/v1/videos/${upload.id}/player"`,
      );
      expect(res.text).toContain('name="twitter:player:width" content="480"');
      expect(res.text).toContain('name="twitter:player:height" content="80"');
      expect(res.text).toContain(
        'name="twitter:player:stream:content_type" content="audio/mpeg"',
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

    test("returns an embeddable <audio> page for an audio upload", async () => {
      const upload = await seedUpload({ mediaType: "audio" });
      await seedMetadata(upload.id, { title: "Podcast ep", visibility: "public" });
      await seedFileVersion(upload.id, {
        status: "complete",
        resolution: "240p",
        mimeType: "audio/mpeg",
      });

      const res = await client.get(`/api/v1/videos/${upload.id}/player`);

      expect(res.status).toBe(200);
      expect(res.text).toContain(
        `<audio src="http://localhost:3000/api/v1/videos/${upload.id}/stream?quality=240p"`,
      );
      expect(res.text).not.toContain("<video");
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
