import { useEffect, useState } from 'react'
import { getFeaturedVideos, getNewestVideos } from '../api/videos.js'
import VideoCard from '../components/VideoCard.jsx'
import './VideoListing.css'

const PAGE_LIMIT = 24

function VideoListing() {
  const [featured, setFeatured] = useState([])
  const [recent, setRecent] = useState([])
  const [visibleCount, setVisibleCount] = useState(PAGE_LIMIT)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const [featuredData, recentData] = await Promise.all([
          getFeaturedVideos(),
          getNewestVideos(),
        ])
        if (!cancelled) {
          const featuredIds = new Set(featuredData.items.map((video) => video.id))
          setFeatured(featuredData.items)
          setRecent(recentData.items.filter((video) => !featuredIds.has(video.id)))
        }
      } catch {
        if (!cancelled) {
          setError('Failed to load videos.')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [])

  const visibleRecent = recent.slice(0, visibleCount)

  return (
    <section className="video-listing">
      {error && <p className="video-listing-error">{error}</p>}
      {!loading && featured.length === 0 && recent.length === 0 && !error && (
        <p className="video-listing-empty">No videos yet.</p>
      )}

      {featured.length > 0 && (
        <div className="video-listing-section">
          <h2 className="video-listing-section-title">Featured Videos</h2>
          <div className="video-listing-grid">
            {featured.map((video) => (
              <VideoCard key={video.id} video={video} />
            ))}
          </div>
        </div>
      )}

      <div className="video-listing-section">
        <h2 className="video-listing-section-title">Recent Uploads</h2>
        <div className="video-listing-grid">
          {visibleRecent.map((video) => (
            <VideoCard key={video.id} video={video} />
          ))}
        </div>
        {visibleCount < recent.length && (
          <button
            type="button"
            className="video-listing-load-more"
            disabled={loading}
            onClick={() => setVisibleCount((prev) => prev + PAGE_LIMIT)}
          >
            Load more
          </button>
        )}
      </div>
    </section>
  )
}

export default VideoListing
