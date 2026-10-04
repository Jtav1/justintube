# Processing container — future feature ideas

Not gitignored-secret material, just notes so we don't lose the rest of the
yt-dlp/ffmpeg brainstorm from the `processing-addl-functionality` branch.
Implemented so far: metadata probe (#1), playlist import (#2), cookies/rate-limit/retries
options (#5), audio-only download (`POST /download/audio`, a variant of #4 — extracts audio
directly via yt-dlp's `-x`, no video download and no mux container), caller-chosen format
download (`POST /download/format` — always re-validates `formatId` against a live probe,
400s with a "call /download/probe first" message otherwise). Everything below is still just
an idea.

## HLS/DASH adaptive packaging (processing side done, webapi side pending)
Package existing renditions into a master `.m3u8` instead of serving flat MP4s only.
Full design + implementation plan: `C:\Users\justin\.claude\plans\rosy-inventing-kurzweil.md`
(option 1 — segment *existing* rendition files via `-c copy`, not a fresh transcode).

**Done** (`processing/`, new `"hls"` job kind): `resolveTranscodedInputPath`/
`resolveHlsOutputDir` (`lib/media-paths.js`), `"hls"` branch in `validateTranscodeJob` +
`buildHlsFfmpegArgs` + `HLS_OUTPUT_FILENAMES` (`lib/transcode.js`), `probeFormatBitRate`
(`lib/probe.js`), `notifyHlsComplete`/`notifyHlsFailed` (`lib/api-client.js`),
`processHlsJob` + dispatch/priority/failure wiring (`lib/queue.js`). 224/224 processing
tests pass including new coverage for all of the above.

**Still pending** (`webapi/`, see the plan file §2-4 for full detail):
- `FILE_VERSION_HLS` model (1:1 child of `FILE_VERSIONS`, status/jobId/playlistPath/bitRateBps)
  + `hlsMasterPlaylistPath` column on `ORIGINAL_UPLOADS` (needs an `ensureSqliteMissingColumns()` entry).
- `maybeEnqueueHlsPackaging()` trigger in `lib/file-versions.js`'s `applyFileVersionComplete`
  (gated by a new `ENABLE_HLS_PACKAGING` env flag + an h264/aac codec-pair allowlist), since a
  rendition's output doesn't exist yet when its `FILE_VERSIONS` row is created — HLS has to be a
  reactive follow-up request, not part of the up-front batch.
- New `POST /internal/hls/:jobId/complete|fail` callback route + `lib/hls-playlist.js`'s
  `regenerateMasterPlaylist()`.
- Two new public streaming routes (`GET /videos/:id/stream/hls` for the master playlist,
  `GET /videos/:id/hls/:versionUuid/:filename` for variant playlist + fMP4 segment, reusing
  `streamFileWithRangeSupport` unchanged for the latter).
- Deletion (`deleteVideo`) and retranscode-route cleanup for `.hls/` directories + the master
  playlist file.

## Storyboard / scrubbing-preview sprite
Tiled thumbnail sheet at fixed intervals + WebVTT sidecar mapping time ranges to
tiles, for hover-scrub preview on the seek bar (`select='not(mod(n,N))'` + `tile=`).

## Loudness normalization
Optional `loudnorm` (EBU R128) pass on rendition/normalize jobs — imported content
varies wildly in level.

## Animated preview clip
Short looping muted clip (GIF/WebP/MP4) for hover-preview in the video grid, same
technique as the existing "embed" job but sourced from a video segment instead of
a still image.

## Chapter extraction
Surface yt-dlp's `chapters` (from `-J`) and/or ffprobe's `-show_chapters` so
webapi can render a chapter-marked seek bar for imported content.

## Subtitle/caption download from source (distinct from #2/#5 work)
yt-dlp `--write-subs --write-auto-subs --sub-langs ... --convert-subs vtt
--skip-download` to pull a source's actual caption tracks, as opposed to the
existing `"subtitle"` job kind which only extracts subtitle streams already
muxed into a file we've already downloaded.

## yt-dlp binary version drift
No current visibility into which yt-dlp version is installed / whether it's
stale. Extractors break constantly upstream; a `/health` field or startup log
line with `yt-dlp --version` would help debugging "import suddenly broken" reports.

## Queueing playlist import through BullMQ
The playlist download route added for #2 is synchronous/sequential (mirrors how
`/download` already works) and capped via `MAX_PLAYLIST_DOWNLOAD_ITEMS`. For large
playlists this should really be a queued, resumable job instead of one blocking
HTTP request — worth revisiting once there's a queue for download (not just
transcode) work.
