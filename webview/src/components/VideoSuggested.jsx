import { useEffect, useState } from 'react'
import { getRandomVideos, searchVideos } from '../api/videos.js'
import VideoCard from './VideoCard.jsx'
import './VideoSuggested.css'

const TOTAL_COUNT = 15
const TAG_MATCH_COUNT = 3

/**
 * Fisher-Yates shuffle, non-mutating.
 * @param {object[]} items Items to shuffle.
 * @returns {object[]} A new, randomly-ordered array.
 */
function shuffle(items) {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

/**
 * Suggested-videos rail shown alongside the video player: an Autoplay toggle
 * (persisted to this browser, see lib/autoplay.js), followed by up to
 * TAG_MATCH_COUNT videos sharing a tag with the current video, plus random
 * videos from everything the viewer can access filling the rest of
 * TOTAL_COUNT - so a video with few/no tag matches still gets a full rail
 * of random suggestions instead of a short one.
 * @param {{
 *   video: object,
 *   autoplayEnabled: boolean,
 *   onAutoplayChange: (enabled: boolean) => void,
 *   onSuggestionsChange?: (items: object[]) => void,
 * }} props The currently-playing video (from getVideo), the Autoplay toggle's
 *   current value and setter (owned by VideoPage so VideoPlayer can read it
 *   too), and an optional callback fired with this rail's loaded suggestions
 *   (so VideoPage can pick one when autoplay's countdown finishes).
 */
function VideoSuggested({ video, autoplayEnabled, onAutoplayChange, onSuggestionsChange }) {
  const [suggestions, setSuggestions] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      const seenIds = new Set([video.id])
      const results = []

      const tags = video.tags ?? []
      if (tags.length > 0) {
        const tagSearches = await Promise.allSettled(
          tags.map((tag) => searchVideos({ tags: [tag], limit: TAG_MATCH_COUNT * 3 })),
        )
        const tagPool = []
        const tagPoolIds = new Set()
        for (const outcome of tagSearches) {
          if (outcome.status !== 'fulfilled') {
            // One tag's search failed (e.g. search backend unavailable) -
            // skip it and keep the others.
            continue
          }
          for (const item of outcome.value.items ?? []) {
            if (!seenIds.has(item.id) && !tagPoolIds.has(item.id)) {
              tagPoolIds.add(item.id)
              tagPool.push(item)
            }
          }
        }
        for (const item of shuffle(tagPool).slice(0, TAG_MATCH_COUNT)) {
          seenIds.add(item.id)
          results.push(item)
        }
      }

      // Fill the rest of TOTAL_COUNT with random videos - this also
      // backfills any tag-match shortfall, so the rail still reaches
      // TOTAL_COUNT even when few/no tags matched.
      const randomTarget = TOTAL_COUNT - results.length
      try {
        // Worst case every fetched video collides with seenIds, so ask for
        // that many extra to still end up with randomTarget after filtering.
        const { items } = await getRandomVideos({
          quantity: randomTarget + seenIds.size,
        })
        const pool = (items ?? []).filter((item) => !seenIds.has(item.id))
        results.push(...pool.slice(0, randomTarget))
      } catch {
        // No random fallback available; show whatever tag matches were found.
      }

      if (!cancelled) {
        setSuggestions(results)
        onSuggestionsChange?.(results)
        setLoading(false)
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [video.id, video.tags, onSuggestionsChange])

  return (
    <aside className="video-suggested">
      <label className="video-suggested-autoplay">
        <span className="video-suggested-autoplay-label">Autoplay</span>
        <span className="video-suggested-autoplay-switch">
          <input
            type="checkbox"
            checked={autoplayEnabled}
            onChange={(event) => onAutoplayChange?.(event.target.checked)}
          />
          <span className="video-suggested-autoplay-track" />
        </span>
      </label>
      {!loading && suggestions.length === 0 && (
        <p className="video-suggested-empty">No suggestions available.</p>
      )}
      {!loading && suggestions.length !== 0 && (
        <p className="video-suggested-title">Suggested Videos</p>
      )}
      <div className="video-suggested-list">
        {suggestions.map((item) => (
          <VideoCard key={item.id} video={item} orientation="horizontal" />
        ))}
      </div>
    </aside>
  )
}

export default VideoSuggested
