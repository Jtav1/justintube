import { useEffect, useState } from 'react'
import { useAuth } from '../context/useAuth.js'
import { listMySubscribers } from '../api/users.js'
import UserCard from '../components/UserCard.jsx'
import './UsersList.css'

const PAGE_LIMIT = 24

function Subscribers() {
  const { user, loading: authLoading } = useAuth()
  const [items, setItems] = useState([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [loading, setLoading] = useState(true)
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
        const data = await listMySubscribers({ page, limit: PAGE_LIMIT })
        if (!cancelled) {
          setItems((prev) => (page === 1 ? data.items : [...prev, ...data.items]))
          setTotalPages(data.totalPages)
        }
      } catch {
        if (!cancelled) {
          setError('Failed to load your subscribers.')
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
  }, [user, page])

  if (authLoading) {
    return null
  }

  if (!user) {
    return (
      <section className="users-listing">
        <p className="users-listing-empty">Log in to see your subscribers.</p>
      </section>
    )
  }

  return (
    <section className="users-listing">
      {error && <p className="users-listing-error">{error}</p>}
      {!loading && items.length === 0 && !error && (
        <p className="users-listing-empty">No subscribers yet.</p>
      )}
      <div className="users-listing-list">
        {items.map((subscriber) => (
          <UserCard key={subscriber.id} user={subscriber} />
        ))}
      </div>
      {page < totalPages && (
        <button
          type="button"
          className="users-listing-load-more"
          disabled={loading}
          onClick={() => setPage((prev) => prev + 1)}
        >
          Load more
        </button>
      )}
    </section>
  )
}

export default Subscribers
