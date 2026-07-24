/**
 * Height → resolution ladder shared with processing probe semantics.
 *
 * @type {Array<{ label: string, height: number }>}
 */
const RESOLUTION_LADDER = [
  { label: "240p", height: 240 },
  { label: "360p", height: 360 },
  { label: "480p", height: 480 },
  { label: "720p", height: 720 },
  { label: "1080p", height: 1080 },
  { label: "2kHD", height: 1440 },
  { label: "4kHD", height: 2160 },
];

/**
 * Maps a frame height to the nearest Justintube resolution label.
 *
 * @param {number} height Frame height in pixels.
 * @returns {string|null} Resolution label, or null when height is invalid.
 */
export function heightToResolution(height) {
  if (!Number.isFinite(height) || height <= 0) {
    return null;
  }

  let best = RESOLUTION_LADDER[0];
  let bestDelta = Math.abs(height - best.height);
  for (const step of RESOLUTION_LADDER) {
    const delta = Math.abs(height - step.height);
    if (delta < bestDelta) {
      best = step;
      bestDelta = delta;
    }
  }
  return best.label;
}

/**
 * Infers a MIME type from a container / file extension token.
 *
 * @param {string} container Container or extension (e.g. mp4, webm).
 * @returns {string|null} MIME type, or null when unknown.
 */
export function mimeTypeForContainer(container) {
  const key = String(container || "")
    .trim()
    .toLowerCase()
    .replace(/^\./, "");
  /** @type {Record<string, string>} */
  const map = {
    mp4: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    mov: "video/quicktime",
  };
  return map[key] || null;
}

/**
 * Builds the planned relative storage path for a transcoded file version.
 *
 * @param {string} uuidName File version UUID (no extension).
 * @param {string} fileExtension Container / extension without a leading dot.
 * @returns {string} Path like `transcoded/<uuid>.<ext>`.
 */
export function plannedTranscodedStoragePath(uuidName, fileExtension) {
  const ext = String(fileExtension || "")
    .trim()
    .toLowerCase()
    .replace(/^\./, "");
  return ext ? `transcoded/${uuidName}.${ext}` : `transcoded/${uuidName}`;
}
