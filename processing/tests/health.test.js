import request from "supertest";
import { createApp } from "../index.js";

describe("GET /health", () => {
  afterEach(() => {
    delete process.env.ENABLE_HW_ACCELERATED_TRANSCODING;
    delete process.env.GPU_ACCELERATION_DEVICE;
    delete process.env.HW_ACCELERATED_TRANSCODING_ENCODERS;
  });

  test("reports hardware acceleration disabled by default", async () => {
    process.env.ENABLE_HW_ACCELERATED_TRANSCODING = "false";
    const app = createApp();

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      hardwareAcceleration: { enabled: false, encoders: [] },
    });
  });

  test("reports hardware acceleration enabled with the configured encoders", async () => {
    process.env.ENABLE_TRANSCODING = "true";
    process.env.ENABLE_HW_ACCELERATED_TRANSCODING = "true";
    process.env.GPU_ACCELERATION_DEVICE = "/dev/dri/renderD128";
    process.env.HW_ACCELERATED_TRANSCODING_ENCODERS =
      '["h264_qsv","hevc_qsv"]';
    const app = createApp();

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      hardwareAcceleration: {
        enabled: true,
        encoders: ["h264_qsv", "hevc_qsv"],
      },
    });
  });
});
