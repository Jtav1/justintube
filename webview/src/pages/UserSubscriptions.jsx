import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import { getSubscriptionFeed } from '../api/videos.js'
import { useInfiniteScroll } from '../hooks/useInfiniteScroll.js'
import VideoCard from '../components/VideoCard.jsx'
import './VideoListing.css'

const PAGE_LIMIT = 24

function UserSubscriptions() {
  const { user, loading: authLoading } = useAuth()
  const { error: toastError } = useToast()
  const [items, setItems] = useState([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) {
      return undefined
    }

    let cancelled = false

    async function load() {
      setLoading(true)
      try {
        const data = await getSubscriptionFeed({ page, limit: PAGE_LIMIT })
        if (!cancelled) {
          setItems((prev) => (page === 1 ? data.items : [...prev, ...data.items]))
          setTotalPages(data.totalPages)
        }
      } catch {
        if (!cancelled) {
          toastError('Failed to load your subscription feed.')
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
  }, [user, page, toastError])

  const hasMore = page < totalPages

  const handleLoadMore = useCallback(() => {
    setPage((prev) => prev + 1)
  }, [])

  const loadMoreRef = useInfiniteScroll({
    hasMore,
    loading,
    onLoadMore: handleLoadMore,
  })

  if (authLoading) {
    return null
  }

  if (!user) {
    return (
      <section className="video-listing">
        <p className="video-listing-empty">Log in to see new content from your subscriptions.</p>
      </section>
    )
  }

  return (
    <section className="video-listing">
      {!loading && items.length === 0 && (
        <p className="video-listing-empty">
          No new videos yet. Subscribe to some channels to see their uploads here.
        </p>
      )}

      <div className="video-listing-section">
        <div className="video-listing-grid">
          {items.map((video) => (
            <VideoCard key={video.id} video={video} />
          ))}
        </div>
        {hasMore && <div className="video-listing-scroll-sentinel" ref={loadMoreRef} />}
      </div>
    </section>
  )
}

export default UserSubscriptions
