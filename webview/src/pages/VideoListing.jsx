import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { getFeaturedVideos, getNewestVideos } from '../api/videos.js'
import VideoCard from '../components/VideoCard.jsx'
import './VideoListing.css'

const PAGE_LIMIT = 24

// Must match .video-listing-grid's grid-template-columns/gap in VideoListing.css
// (repeat(auto-fill, minmax(FEATURED_MIN_CARD_WIDTH, 1fr)), gap: FEATURED_GRID_GAP),
// so the featured row can be trimmed to exactly what fits on one line.
const FEATURED_MIN_CARD_WIDTH = 180
const FEATURED_GRID_GAP = 10

function VideoListing() {
  const [featured, setFeatured] = useState([])
  const [recent, setRecent] = useState([])
  const [visibleCount, setVisibleCount] = useState(PAGE_LIMIT)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [featuredColumns, setFeaturedColumns] = useState(1)
  const featuredGridRef = useRef(null)

  useEffect(() => {
    const el = featuredGridRef.current
    if (!el) {
      return undefined
    }

    function measure() {
      const columns = Math.max(
        1,
        Math.floor(
          (el.clientWidth + FEATURED_GRID_GAP) / (FEATURED_MIN_CARD_WIDTH + FEATURED_GRID_GAP),
        ),
      )
      setFeaturedColumns(columns)
    }

    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [featured])

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
          setFeatured(featuredData.items)
          setRecent(recentData.items)
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
  const featuredOverflowing = featured.length > featuredColumns
  const visibleFeatured = featuredOverflowing
    ? featured.slice(0, Math.max(featuredColumns - 1, 0))
    : featured

  return (
    <section className="video-listing">
      {error && <p className="video-listing-error">{error}</p>}
      {!loading && featured.length === 0 && recent.length === 0 && !error && (
        <p className="video-listing-empty">No videos yet.</p>
      )}

      {featured.length > 0 && (
        <div className="video-listing-section">
          <h2 className="video-listing-section-title">Featured Videos</h2>
          <div className="video-listing-grid" ref={featuredGridRef}>
            {visibleFeatured.map((video) => (
              <VideoCard key={video.id} video={video} />
            ))}
            {featuredOverflowing && (
              <Link to="/featured" className="video-listing-more">
                <span className="video-listing-more-thumb">
                  <span className="video-listing-more-circle">
                    <ArrowRight size={28} />
                  </span>
                </span>
                <span className="video-listing-more-label">More...</span>
              </Link>
            )}
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
