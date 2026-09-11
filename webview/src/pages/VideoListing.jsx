import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { getFeaturedVideos, getNewestVideos } from '../api/videos.js'
import { listLivestreams } from '../api/livestreams.js'
import { useToast } from '../context/useToast.js'
import { useSiteConfig } from '../context/useSiteConfig.js'
import { useInfiniteScroll } from '../hooks/useInfiniteScroll.js'
import { useIsMobile } from '../lib/viewport.js'
import VideoCard from '../components/VideoCard.jsx'
import LiveStreamCard from '../components/LiveStreamCard.jsx'
import './VideoListing.css'

const PAGE_LIMIT = 24
const FEATURED_LIMIT = 12

// On mobile the featured row becomes a one-card-at-a-time swipeable carousel
// instead of being fit to measured column count - cap it at a fixed count.
const MOBILE_FEATURED_LIMIT = 5

// Must match .video-listing-grid's grid-template-columns/gap in VideoListing.css
// (repeat(auto-fill, minmax(FEATURED_MIN_CARD_WIDTH, 1fr)), gap: FEATURED_GRID_GAP),
// so the featured row can be trimmed to exactly what fits on one line.
const FEATURED_MIN_CARD_WIDTH = 180
const FEATURED_GRID_GAP = 10

function VideoListing() {
  const { error: toastError } = useToast()
  const { livestreamEnabled } = useSiteConfig()
  const isMobile = useIsMobile()
  const [live, setLive] = useState([])
  const [featured, setFeatured] = useState([])
  const [recent, setRecent] = useState([])
  const [recentPage, setRecentPage] = useState(1)
  const [recentTotalPages, setRecentTotalPages] = useState(0)
  const [loading, setLoading] = useState(true)
  const [recentLoading, setRecentLoading] = useState(true)
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

  // Featured strip only ever shows what fits on one row (see visibleFeatured
  // below), with a link to the full /featured page for more - fetch it once,
  // bounded, rather than paginating it here.
  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      try {
        const featuredData = await getFeaturedVideos({ limit: FEATURED_LIMIT })
        if (!cancelled) {
          setFeatured(featuredData.items)
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

  // Recent Uploads is server-paginated: each scroll-triggered page bump below
  // fetches the next slice instead of slicing an already-downloaded array.
  useEffect(() => {
    let cancelled = false

    async function load() {
      setRecentLoading(true)
      try {
        const recentData = await getNewestVideos({ page: recentPage, limit: PAGE_LIMIT })
        if (!cancelled) {
          setRecent((prev) =>
            recentPage === 1 ? recentData.items : [...prev, ...recentData.items],
          )
          setRecentTotalPages(recentData.totalPages)
        }
      } catch {
        if (!cancelled) {
          toastError('Failed to load videos.')
        }
      } finally {
        if (!cancelled) {
          setRecentLoading(false)
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [recentPage, toastError])

  const hasMoreRecent = recentPage < recentTotalPages

  const handleLoadMoreRecent = useCallback(() => {
    setRecentPage((prev) => prev + 1)
  }, [])

  const loadMoreRef = useInfiniteScroll({
    hasMore: hasMoreRecent,
    loading: recentLoading,
    onLoadMore: handleLoadMoreRecent,
  })

  const featuredOverflowing = isMobile
    ? featured.length > MOBILE_FEATURED_LIMIT
    : featured.length > featuredColumns
  const visibleFeatured = isMobile
    ? featured.slice(0, MOBILE_FEATURED_LIMIT)
    : featuredOverflowing
      ? featured.slice(0, Math.max(featuredColumns - 1, 0))
      : featured

  return (
    <section className="video-listing">
      {!loading && !recentLoading && live.length === 0 && featured.length === 0 && recent.length === 0 && (
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
          <div className="video-listing-grid video-listing-featured-grid" ref={featuredGridRef}>
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
          {recent.map((video) => (
            <VideoCard key={video.id} video={video} />
          ))}
        </div>
        {hasMoreRecent && <div className="video-listing-scroll-sentinel" ref={loadMoreRef} />}
      </div>
    </section>
  )
}

export default VideoListing
