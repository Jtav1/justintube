import { useEffect, useState } from 'react'
import { searchVideos } from '../api/videos.js'
import VideoCard from '../components/VideoCard.jsx'
import './VideoListing.css'

const PAGE_LIMIT = 24

function VideoListing() {
  const [items, setItems] = useState([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const data = await searchVideos({ sort: 'newest', page, limit: PAGE_LIMIT })
        if (!cancelled) {
          setItems((prev) => (page === 1 ? data.items : [...prev, ...data.items]))
          setTotalPages(data.totalPages)
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
  }, [page])

  return (
    <section className="video-listing">
      {error && <p className="video-listing-error">{error}</p>}
      {!loading && items.length === 0 && !error && (
        <p className="video-listing-empty">No videos yet.</p>
      )}
      <div className="video-listing-grid">
        {items.map((video) => (
          <VideoCard key={video.id} video={video} />
        ))}
      </div>
      {page < totalPages && (
        <button
          type="button"
          className="video-listing-load-more"
          disabled={loading}
          onClick={() => setPage((prev) => prev + 1)}
        >
          {loading ? 'Loading...' : 'Load more'}
        </button>
      )}
    </section>
  )
}

export default VideoListing
