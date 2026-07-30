import { useEffect, useState } from 'react'
import { listPlaylists } from '../api/playlists.js'
import PlaylistCard from '../components/PlaylistCard.jsx'
import './Playlists.css'

const PAGE_LIMIT = 24

function Playlists() {
  const [items, setItems] = useState([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const data = await listPlaylists({ page, limit: PAGE_LIMIT })
        if (!cancelled) {
          setItems((prev) => (page === 1 ? data.items : [...prev, ...data.items]))
          setTotalPages(data.totalPages)
        }
      } catch {
        if (!cancelled) {
          setError('Failed to load playlists.')
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
    <section className="playlists-listing">
      {error && <p className="playlists-listing-error">{error}</p>}
      {!loading && items.length === 0 && !error && (
        <p className="playlists-listing-empty">No playlists yet.</p>
      )}
      <div className="playlists-listing-grid">
        {items.map((playlist) => (
          <PlaylistCard key={playlist.id} playlist={playlist} />
        ))}
      </div>
      {page < totalPages && (
        <button
          type="button"
          className="playlists-listing-load-more"
          disabled={loading}
          onClick={() => setPage((prev) => prev + 1)}
        >
          Load more
        </button>
      )}
    </section>
  )
}

export default Playlists
