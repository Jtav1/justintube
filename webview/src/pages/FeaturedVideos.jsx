import { useCallback, useEffect, useState } from 'react'
import { getFeaturedVideos } from '../api/videos.js'
import { useToast } from '../context/useToast.js'
import { useInfiniteScroll } from '../hooks/useInfiniteScroll.js'
import VideoCard from '../components/VideoCard.jsx'
import './VideoListing.css'

const PAGE_LIMIT = 24

function FeaturedVideos() {
  const { error: toastError } = useToast()
  const [featured, setFeatured] = useState([])
  const [visibleCount, setVisibleCount] = useState(PAGE_LIMIT)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      try {
        const data = await getFeaturedVideos()
        if (!cancelled) {
          setFeatured(data.items)
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
    }

    load()

    return () => {
      cancelled = true
    }
  }, [toastError])

  const visibleFeatured = featured.slice(0, visibleCount)
  const hasMoreFeatured = visibleCount < featured.length

  const handleLoadMoreFeatured = useCallback(() => {
    setVisibleCount((prev) => prev + PAGE_LIMIT)
  }, [])

  const loadMoreRef = useInfiniteScroll({
    hasMore: hasMoreFeatured,
    loading,
    onLoadMore: handleLoadMoreFeatured,
  })

  return (
    <section className="video-listing">
      {!loading && featured.length === 0 && (
        <p className="video-listing-empty">No featured videos yet.</p>
      )}

      <div className="video-listing-section">
        <h2 className="video-listing-section-title">Featured Videos</h2>
        <div className="video-listing-grid">
          {visibleFeatured.map((video) => (
            <VideoCard key={video.id} video={video} />
          ))}
        </div>
        {hasMoreFeatured && <div className="video-listing-scroll-sentinel" ref={loadMoreRef} />}
      </div>
    </section>
  )
}

export default FeaturedVideos
