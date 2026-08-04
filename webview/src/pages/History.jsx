import { useEffect, useState } from 'react'
import { useAuth } from '../context/useAuth.js'
import { clearMyHistory, getMyHistory, removeHistoryEntry } from '../api/videos.js'
import VideoCard from '../components/VideoCard.jsx'
import './VideoListing.css'

const PAGE_LIMIT = 24

function History() {
  const { user, loading: authLoading } = useAuth()
  const [items, setItems] = useState([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!user) {
      return undefined
    }

    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const data = await getMyHistory({ page: 1, limit: PAGE_LIMIT })
        if (!cancelled) {
          setItems(data.items)
          setPage(data.page)
          setTotalPages(data.totalPages)
        }
      } catch {
        if (!cancelled) {
          setError('Failed to load your watch history.')
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
  }, [user])

  async function handleLoadMore() {
    if (loadingMore) {
      return
    }
    setLoadingMore(true)
    try {
      const data = await getMyHistory({ page: page + 1, limit: PAGE_LIMIT })
      setItems((prev) => [...prev, ...data.items])
      setPage(data.page)
      setTotalPages(data.totalPages)
    } catch {
      setError('Failed to load more videos.')
    } finally {
      setLoadingMore(false)
    }
  }

  async function handleRemove(historyId) {
    try {
      await removeHistoryEntry(historyId)
      setItems((prev) => prev.filter((item) => item.historyId !== historyId))
    } catch {
      setError('Failed to remove from history.')
    }
  }

  async function handleClearAll() {
    if (!window.confirm('Clear your entire watch history? This cannot be undone.')) {
      return
    }
    try {
      await clearMyHistory()
      setItems([])
      setTotalPages(0)
    } catch {
      setError('Failed to clear your watch history.')
    }
  }

  if (authLoading) {
    return null
  }

  if (!user) {
    return (
      <section className="video-listing">
        <p className="video-listing-empty">Log in to view your watch history.</p>
      </section>
    )
  }

  return (
    <section className="video-listing">
      {error && <p className="video-listing-error">{error}</p>}
      {!loading && items.length === 0 && !error && (
        <p className="video-listing-empty">You haven't watched any videos yet.</p>
      )}

      <div className="video-listing-section">
        <div className="video-listing-section-header">
          <h2 className="video-listing-section-title">Watch History</h2>
          {items.length > 0 && (
            <button type="button" className="video-listing-clear-all" onClick={handleClearAll}>
              Clear history
            </button>
          )}
        </div>
        <div className="video-listing-grid">
          {items.map((video) => (
            <VideoCard
              key={video.historyId}
              video={video}
              onRemoveFromHistory={() => handleRemove(video.historyId)}
            />
          ))}
        </div>
        {page < totalPages && (
          <button
            type="button"
            className="video-listing-load-more"
            disabled={loadingMore}
            onClick={handleLoadMore}
          >
            Load more
          </button>
        )}
      </div>
    </section>
  )
}

export default History
