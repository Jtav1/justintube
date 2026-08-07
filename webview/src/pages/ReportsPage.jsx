import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import { listMyReports, listReports } from '../api/reports.js'
import ReportCard from '../components/ReportCard.jsx'
import './ReportsPage.css'

const PAGE_LIMIT = 24

function ReportsPage() {
  const { user, loading: authLoading } = useAuth()
  const { error: toastError } = useToast()
  const navigate = useNavigate()

  const [items, setItems] = useState([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  const isModerator = user?.role === 'admin' || user?.role === 'moderator'

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/login')
    }
  }, [authLoading, user, navigate])

  useEffect(() => {
    if (authLoading || !user) {
      return undefined
    }

    let cancelled = false

    async function load() {
      setLoading(true)
      try {
        const data = isModerator
          ? await listReports({ page, limit: PAGE_LIMIT })
          : await listMyReports({ page, limit: PAGE_LIMIT })
        if (!cancelled) {
          setItems((prev) => (page === 1 ? data.items : [...prev, ...data.items]))
          setTotal(data.total)
        }
      } catch {
        if (!cancelled) {
          toastError('Failed to load reports.')
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
  }, [authLoading, user, isModerator, page, toastError])

  if (authLoading || !user) {
    return null
  }

  const hasMore = items.length < total

  return (
    <section className="reports-page">
      <div className="reports-page-header">
        <h1>Reports</h1>
        <button
          type="button"
          className="reports-page-new"
          onClick={() => navigate('/reports/new', { state: { link: window.location.href } })}
        >
          <Plus size={16} />
          New Report
        </button>
      </div>

      {!loading && items.length === 0 && <p className="reports-page-empty">No reports yet.</p>}

      <div className="reports-page-grid">
        {items.map((report) => (
          <ReportCard key={report.id} report={report} />
        ))}
      </div>

      {hasMore && (
        <button
          type="button"
          className="reports-page-load-more"
          disabled={loading}
          onClick={() => setPage((prev) => prev + 1)}
        >
          Load more
        </button>
      )}
    </section>
  )
}

export default ReportsPage
