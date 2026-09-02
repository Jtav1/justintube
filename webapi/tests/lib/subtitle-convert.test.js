import { describe, expect, test } from "@jest/globals";
import { srtToVtt } from "../../lib/subtitle-convert.js";

describe("srtToVtt", () => {
  test("adds a WEBVTT header and converts comma to period in timestamps", () => {
    const srt = [
      "1",
      "00:00:01,000 --> 00:00:04,500",
      "Hello there.",
      "",
      "2",
      "00:00:05,000 --> 00:00:07,000",
      "General Kenobi.",
      "",
    ].join("\n");

    const vtt = srtToVtt(srt);

    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:01.000 --> 00:00:04.500");
    expect(vtt).toContain("00:00:05.000 --> 00:00:07.000");
    expect(vtt).toContain("Hello there.");
    expect(vtt).toContain("General Kenobi.");
    expect(vtt).not.toContain(",000");
  });

  test("strips a leading BOM and normalizes CRLF line endings", () => {
    const srt = "﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n";

    const vtt = srtToVtt(srt);

    expect(vtt.startsWith("WEBVTT\n\n1\n")).toBe(true);
    expect(vtt).not.toContain("\r");
    expect(vtt).not.toContain("﻿");
  });

  test("preserves multi-line cue text", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nLine one\nLine two\n";

    const vtt = srtToVtt(srt);

    expect(vtt).toContain("Line one\nLine two");
  });
});
