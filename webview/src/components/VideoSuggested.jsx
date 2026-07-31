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
 * matching any of the current video's first few tags (searched individually
 * and merged), then fills any remaining slots with a random selection from
 * every video the viewer can access.
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
        const tagSearches = await Promise.allSettled(
          topTags.map((tag) => searchVideos({ tags: [tag], limit: TARGET_COUNT })),
        )
        for (const outcome of tagSearches) {
          if (outcome.status !== 'fulfilled') {
            // One tag's search failed (e.g. search backend unavailable) -
            // skip it and keep the others.
            continue
          }
          for (const item of outcome.value.items ?? []) {
            if (!seenIds.has(item.id)) {
              seenIds.add(item.id)
              results.push(item)
            }
          }
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
