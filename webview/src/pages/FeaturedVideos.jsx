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
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      try {
        const data = await getFeaturedVideos({ page, limit: PAGE_LIMIT })
        if (!cancelled) {
          setFeatured((prev) => (page === 1 ? data.items : [...prev, ...data.items]))
          setTotalPages(data.totalPages)
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
  }, [page, toastError])

  const hasMoreFeatured = page < totalPages

  const handleLoadMoreFeatured = useCallback(() => {
    setPage((prev) => prev + 1)
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
          {featured.map((video) => (
            <VideoCard key={video.id} video={video} />
          ))}
        </div>
        {hasMoreFeatured && <div className="video-listing-scroll-sentinel" ref={loadMoreRef} />}
      </div>
    </section>
  )
}

export default FeaturedVideos
