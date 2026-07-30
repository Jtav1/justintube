import { useEffect, useState } from 'react'
import { getNewestVideos, searchVideos } from '../api/videos.js'
import VideoCard from './VideoCard.jsx'
import './VideoSuggested.css'

const TARGET_COUNT = 10
const TOP_TAG_COUNT = 3

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
 * Suggested-videos rail shown alongside the video player. Prefers videos
 * sharing the current video's top tags, then fills any remaining slots with
 * a random selection from every video the viewer can access.
 * @param {{video: object}} props The currently-playing video (from getVideo).
 */
function VideoSuggested({ video }) {
  const [suggestions, setSuggestions] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      const seenIds = new Set([video.id])
      let results = []

      const topTags = (video.tags ?? []).slice(0, TOP_TAG_COUNT)
      if (topTags.length > 0) {
        try {
          const tagMatches = await searchVideos({ tags: topTags, limit: TARGET_COUNT })
          for (const item of tagMatches.items ?? []) {
            if (!seenIds.has(item.id)) {
              seenIds.add(item.id)
              results.push(item)
            }
          }
        } catch {
          // Tag-based search failed (e.g. search backend unavailable) - fall
          // through to the random fallback below.
        }
      }

      if (results.length < TARGET_COUNT) {
        try {
          const all = await getNewestVideos()
          const pool = (all.items ?? []).filter((item) => !seenIds.has(item.id))
          results = results.concat(shuffle(pool).slice(0, TARGET_COUNT - results.length))
        } catch {
          // No fallback available; show whatever tag matches were found.
        }
      }

      if (!cancelled) {
        setSuggestions(results.slice(0, TARGET_COUNT))
        setLoading(false)
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [video.id, video.tags])

  return (
    <aside className="video-suggested">
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
