import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { getUserChannel } from '../api/users.js'
import { listUserPlaylists } from '../api/playlists.js'
import { useToast } from '../context/useToast.js'
import PlaylistCard from '../components/PlaylistCard.jsx'
import './UserPlaylists.css'

const PAGE_LIMIT = 24

function UserPlaylists() {
  const { username } = useParams()
  const { error: toastError } = useToast()

  const [displayName, setDisplayName] = useState(null)
  const [userError, setUserError] = useState(null)

  const [items, setItems] = useState([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function loadUser() {
      try {
        const data = await getUserChannel(username, { limit: 1 })
        if (!cancelled) {
          setDisplayName(data.user.displayName || data.user.username)
        }
      } catch {
        if (!cancelled) {
          setUserError('User not found.')
          toastError('Failed to load this user.')
        }
      }
    }

    loadUser()

    return () => {
      cancelled = true
    }
  }, [username, toastError])

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      try {
        const data = await listUserPlaylists(username, { page, limit: PAGE_LIMIT })
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
  }, [username, page, toastError])

  if (userError) {
    return (
      <section className="user-playlists-page">
        <p className="user-playlists-error">{userError}</p>
      </section>
    )
  }

  return (
    <section className="user-playlists-page">
      <h1 className="user-playlists-title">
        {displayName ? `${displayName}'s Playlists` : 'Playlists'}
      </h1>

      {!loading && items.length === 0 && (
        <p className="user-playlists-empty">No playlists yet.</p>
      )}
      <div className="user-playlists-grid">
        {items.map((playlist) => (
          <PlaylistCard key={playlist.id} playlist={playlist} />
        ))}
      </div>
      {page < totalPages && (
        <button
          type="button"
          className="user-playlists-load-more"
          disabled={loading}
          onClick={() => setPage((prev) => prev + 1)}
        >
          Load more
        </button>
      )}
    </section>
  )
}

export default UserPlaylists
