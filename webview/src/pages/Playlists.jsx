import { useCallback, useEffect, useState } from 'react'
import { listPlaylists } from '../api/playlists.js'
import { useToast } from '../context/useToast.js'
import { useInfiniteScroll } from '../hooks/useInfiniteScroll.js'
import PlaylistCard from '../components/PlaylistCard.jsx'
import './Playlists.css'

const PAGE_LIMIT = 24

function Playlists() {
  const { error: toastError } = useToast()
  const [items, setItems] = useState([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      try {
        const data = await listPlaylists({ page, limit: PAGE_LIMIT })
        if (!cancelled) {
          setItems((prev) => (page === 1 ? data.items : [...prev, ...data.items]))
          setTotalPages(data.totalPages)
        }
      } catch {
        if (!cancelled) {
          toastError('Failed to load playlists.')
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

  const hasMore = page < totalPages

  const handleLoadMore = useCallback(() => {
    setPage((prev) => prev + 1)
  }, [])

  const loadMoreRef = useInfiniteScroll({ hasMore, loading, onLoadMore: handleLoadMore })

  return (
    <section className="playlists-listing">
      {!loading && items.length === 0 && (
        <p className="playlists-listing-empty">No playlists yet.</p>
      )}
      <div className="playlists-listing-grid">
        {items.map((playlist) => (
          <PlaylistCard key={playlist.id} playlist={playlist} />
        ))}
      </div>
      {hasMore && <div className="playlists-listing-scroll-sentinel" ref={loadMoreRef} />}
    </section>
  )
}

export default Playlists
