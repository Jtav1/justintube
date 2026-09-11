/**
 * Converts SRT subtitle text to WebVTT: strips a leading BOM, normalizes
 * CRLF to LF, prefixes the required "WEBVTT" header, and converts SRT's
 * comma millisecond separator to WebVTT's period (e.g. "00:00:01,000" ->
 * "00:00:01.000"). Cue-number lines and blank-line block separators are
 * valid in both formats, so nothing else needs to change.
 *
 * @param {string} srtText Raw .srt file contents.
 * @returns {string} WebVTT file contents, starting with a "WEBVTT" header.
 */
export function srtToVtt(srtText) {
  const body = String(srtText)
    .replace(/^﻿/, "")
    .replace(/\r\n/g, "\n")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
    .trim();
  return `WEBVTT\n\n${body}\n`;
}
