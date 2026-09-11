import { getVideo } from '../api/videos.js'

// Only one "next" video is ever warmed ahead of time, so a single slot suffices.
let pending = null

/**
 * Starts fetching a video's metadata ahead of navigation, so a subsequent
 * `getVideoOrPrefetched` call for the same id can resolve instantly instead
 * of firing a fresh request. Safe to call repeatedly - re-prefetching the
 * same id is a no-op, and prefetching a different id replaces the pending
 * one (only the most recently predicted "next" video matters).
 * @param {string|number} id Numeric video id or its public videoId.
 * @returns {void}
 */
export function prefetchVideo(id) {
  if (pending?.id === id) {
    return
  }
  pending = { id, promise: getVideo(id) }
  // Prevents an unconsumed failed prefetch from surfacing as an unhandled
  // rejection; getVideoOrPrefetched still re-throws it to an actual awaiter.
  pending.promise.catch(() => {})
}

/**
 * Resolves a video's metadata, reusing a matching in-flight/completed
 * prefetch from `prefetchVideo` when one exists instead of firing a new
 * request.
 * @param {string|number} id Numeric video id or its public videoId.
 * @returns {Promise<object>}
 */
export function getVideoOrPrefetched(id) {
  if (pending?.id === id) {
    const { promise } = pending
    pending = null
    return promise
  }
  return getVideo(id)
}
