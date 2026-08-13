import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { getFeaturedVideos, getNewestVideos } from '../api/videos.js'
import { listLivestreams } from '../api/livestreams.js'
import { useToast } from '../context/useToast.js'
import { useSiteConfig } from '../context/useSiteConfig.js'
import { useInfiniteScroll } from '../hooks/useInfiniteScroll.js'
import VideoCard from '../components/VideoCard.jsx'
import LiveStreamCard from '../components/LiveStreamCard.jsx'
import './VideoListing.css'

const PAGE_LIMIT = 24

// Must match .video-listing-grid's grid-template-columns/gap in VideoListing.css
// (repeat(auto-fill, minmax(FEATURED_MIN_CARD_WIDTH, 1fr)), gap: FEATURED_GRID_GAP),
// so the featured row can be trimmed to exactly what fits on one line.
const FEATURED_MIN_CARD_WIDTH = 180
const FEATURED_GRID_GAP = 10

function VideoListing() {
  const { error: toastError } = useToast()
  const { livestreamEnabled } = useSiteConfig()
  const [live, setLive] = useState([])
  const [featured, setFeatured] = useState([])
  const [recent, setRecent] = useState([])
  const [visibleCount, setVisibleCount] = useState(PAGE_LIMIT)
  const [loading, setLoading] = useState(true)
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
          toastError('Failed to load videos.')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }

      // A "Live Now" section is a nice-to-have on top of the main listing -
      // fail silently rather than toasting an error for it. Skipped entirely
      // when livestreaming is disabled, since the underlying route is unmounted.
      if (livestreamEnabled) {
        try {
          const liveData = await listLivestreams({ limit: 12 })
          if (!cancelled) {
            setLive(liveData.items)
          }
        } catch {
          // ignore
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [toastError, livestreamEnabled])

  const visibleRecent = recent.slice(0, visibleCount)
  const hasMoreRecent = visibleCount < recent.length

  const handleLoadMoreRecent = useCallback(() => {
    setVisibleCount((prev) => prev + PAGE_LIMIT)
  }, [])

  const loadMoreRef = useInfiniteScroll({
    hasMore: hasMoreRecent,
    loading,
    onLoadMore: handleLoadMoreRecent,
  })

  const featuredOverflowing = featured.length > featuredColumns
  const visibleFeatured = featuredOverflowing
    ? featured.slice(0, Math.max(featuredColumns - 1, 0))
    : featured

  return (
    <section className="video-listing">
      {!loading && live.length === 0 && featured.length === 0 && recent.length === 0 && (
        <p className="video-listing-empty">No videos yet.</p>
      )}

      {live.length > 0 && (
        <div className="video-listing-section">
          <h2 className="video-listing-section-title">Live Now</h2>
          <div className="video-listing-grid">
            {live.map((livestream) => (
              <LiveStreamCard key={livestream.id} livestream={livestream} />
            ))}
          </div>
        </div>
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
        {hasMoreRecent && <div className="video-listing-scroll-sentinel" ref={loadMoreRef} />}
      </div>
    </section>
  )
}

export default VideoListing
