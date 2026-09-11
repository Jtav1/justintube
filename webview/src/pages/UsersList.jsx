import { useEffect, useState } from 'react'
import { listUsers } from '../api/users.js'
import { useToast } from '../context/useToast.js'
import UserCard from '../components/UserCard.jsx'
import './UsersList.css'

const PAGE_LIMIT = 24

function UsersList() {
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
        const data = await listUsers({ page, limit: PAGE_LIMIT })
        if (!cancelled) {
          setItems((prev) => (page === 1 ? data.items : [...prev, ...data.items]))
          setTotalPages(data.totalPages)
        }
      } catch {
        if (!cancelled) {
          toastError('Failed to load users.')
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

  return (
    <section className="users-listing">
      {!loading && items.length === 0 && (
        <p className="users-listing-empty">No users yet.</p>
      )}
      <div className="users-listing-list">
        {items.map((user) => (
          <UserCard key={user.id} user={user} />
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

export default UsersList
