/**
 * Every processing job kind the UI surfaces, in a fixed display order.
 * Matches the kinds processing (BullMQ) actually dispatches on.
 * @type {string[]}
 */
export const JOB_KINDS = ['thumbnail', 'normalize', 'rendition', 'embed', 'hash', 'subtitle']

/**
 * The subset of job kinds that block a video from being fully usable and
 * are shown on VideoCard's owner-only processing overlay - hash
 * (duplicate-detection) and embed (audio-upload link-unfurl video) run
 * invisibly in the background and don't affect playability.
 * @type {string[]}
 */
export const CORE_JOB_KINDS = ['rendition', 'thumbnail', 'normalize']

/**
 * Human-facing label per job kind.
 * @type {Record<string, string>}
 */
const JOB_KIND_LABELS = {
  thumbnail: 'Thumbnail',
  normalize: 'Normalize',
  rendition: 'Rendition',
  embed: 'Embed video',
  hash: 'Duplicate hash',
  subtitle: 'Subtitle extraction',
}

/**
 * Fixed categorical color per job kind, shared by the admin queue card and
 * the VideoCard processing overlay so the two surfaces never drift apart.
 * A single palette (not light/dark variants) since this app's themes are
 * arbitrary user-selectable color sets rather than a light/dark toggle -
 * these mid-tone, saturated hues read reasonably against both a themed
 * panel background and the overlay's fixed dark scrim. Always pair with a
 * visible text label (not color alone), since color perception varies.
 * @type {Record<string, string>}
 */
const JOB_KIND_COLORS = {
  thumbnail: '#3987e5',
  normalize: '#d95926',
  rendition: '#199e70',
  embed: '#c98500',
  hash: '#d55181',
  subtitle: '#7b61ff',
}

/**
 * Neutral fallback color for a job kind the UI doesn't recognize (forward
 * compatible with a future kind processing might add).
 * @type {string}
 */
const FALLBACK_COLOR = '#8a8a8a'

/**
 * Looks up a job kind's display color.
 * @param {string} kind
 * @returns {string} Hex color.
 */
export function colorForJobKind(kind) {
  return JOB_KIND_COLORS[kind] || FALLBACK_COLOR
}

/**
 * Looks up a job kind's display label, falling back to the raw kind string.
 * @param {string} kind
 * @returns {string}
 */
export function labelForJobKind(kind) {
  return JOB_KIND_LABELS[kind] || kind
}
