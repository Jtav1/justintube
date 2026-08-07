import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { MessageSquareWarning } from 'lucide-react'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import {
  createReport,
  deleteReport,
  getReport,
  listMyReports,
  moderateReport,
  updateReport,
} from '../api/reports.js'
import './ReportForm.css'

const REPORT_TYPE_OPTIONS = [
  { value: 'video', label: 'Video' },
  { value: 'playlist', label: 'Playlist' },
  { value: 'user', label: 'User' },
  { value: 'website', label: 'Site' },
  { value: 'system', label: 'System' },
]

const MAX_LINK_LENGTH = 2048
const MAX_TEXT_LENGTH = 1000
// webapi's parsePagination caps limit at 99 (see webapi/lib/pagination.js
// MAX_LIMIT) - requesting 100 gets rejected with a 400.
const OWNER_REPORT_SEARCH_LIMIT = 99

function ReportForm() {
  const { user, loading: authLoading } = useAuth()
  const { success, error: toastError } = useToast()
  const navigate = useNavigate()
  const location = useLocation()
  const { id: reportId } = useParams()
  const isEditMode = Boolean(reportId)

  const prefill = isEditMode ? {} : (location.state ?? {})

  const [reportType, setReportType] = useState(prefill.reportType ?? 'website')
  const [link, setLink] = useState(prefill.link ?? '')
  const [description, setDescription] = useState('')
  const [videoId] = useState(prefill.videoId ?? null)
  const [reportedUserId] = useState(prefill.reportedUserId ?? null)
  const [playlistId] = useState(prefill.playlistId ?? null)

  const [report, setReport] = useState(isEditMode ? (location.state?.report ?? null) : null)
  const [loading, setLoading] = useState(isEditMode && !location.state?.report)
  const [loadError, setLoadError] = useState(null)

  const [moderatorResolved, setModeratorResolved] = useState(false)
  const [moderatorComment, setModeratorComment] = useState('')
  // Tracks which report's fields the form state was last synced from, so a
  // freshly loaded report (a new id) resets the editable fields, but saving
  // an update to the same report (same id) doesn't clobber what the user
  // just typed. Adjusted during render per
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes.
  const [syncedReportId, setSyncedReportId] = useState(null)

  const [submitting, setSubmitting] = useState(false)
  const [closing, setClosing] = useState(false)
  const [moderating, setModerating] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const isModerator = user?.role === 'admin' || user?.role === 'moderator'
  const isAdmin = user?.role === 'admin'

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/login')
    }
  }, [authLoading, user, navigate])

  useEffect(() => {
    if (authLoading || !user || !isEditMode || report) {
      return undefined
    }

    let cancelled = false

    async function load() {
      setLoading(true)
      setLoadError(null)
      try {
        let data = null
        if (isModerator) {
          data = await getReport(reportId)
        } else {
          // GET /reports/:id is moderator/admin-only, so a report's own
          // creator has no direct fetch-by-id - fall back to searching
          // their own report list (the normal path is arriving here via
          // a ReportCard click, which already carries the record via
          // router state and skips this branch entirely).
          const mine = await listMyReports({ limit: OWNER_REPORT_SEARCH_LIMIT })
          data = mine.items.find((item) => String(item.id) === String(reportId)) ?? null
        }
        if (!cancelled) {
          if (!data) {
            setLoadError('This report is unavailable right now.')
          } else {
            setReport(data)
          }
        }
      } catch {
        if (!cancelled) {
          setLoadError('This report is unavailable right now.')
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
  }, [authLoading, user, isEditMode, isModerator, reportId, report])

  if (report && report.id !== syncedReportId) {
    setSyncedReportId(report.id)
    setDescription(report.description ?? '')
    setModeratorResolved(report.resolved)
    setModeratorComment('')
  }

  if (authLoading || !user) {
    return null
  }

  if (isEditMode && loading) {
    return null
  }

  if (isEditMode && (loadError || !report)) {
    return (
      <section className="report-form-page">
        <div className="report-form-card">
          <h1>Report</h1>
          <p className="report-form-hint">{loadError ?? 'This report is unavailable right now.'}</p>
        </div>
      </section>
    )
  }

  const isOwner = isEditMode && String(report.reporter?.userId) === String(user.id)
  const canClose = isOwner && !report.resolved

  async function handleCreateSubmit(event) {
    event.preventDefault()
    if (submitting) {
      return
    }
    setSubmitting(true)
    try {
      const created = await createReport({
        reportType,
        link: link.trim(),
        description: description.trim(),
        videoId: videoId ?? undefined,
        reportedUserId: reportedUserId ?? undefined,
        playlistId: playlistId ?? undefined,
      })
      success('Report submitted.')
      navigate(`/reports/${created.id}`, { state: { report: created }, replace: true })
    } catch {
      toastError('Failed to submit the report. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleOwnerSave(event) {
    event.preventDefault()
    if (submitting) {
      return
    }
    setSubmitting(true)
    try {
      const updated = await updateReport(reportId, { description: description.trim() })
      setReport(updated)
      success('Report updated.')
    } catch {
      toastError('Failed to save changes. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleClose() {
    if (closing) {
      return
    }
    setClosing(true)
    try {
      const updated = await updateReport(reportId, { resolved: true })
      setReport(updated)
      success('Report closed.')
    } catch {
      toastError('Failed to close the report. Please try again.')
    } finally {
      setClosing(false)
    }
  }

  async function handleModerate(event) {
    event.preventDefault()
    if (moderating) {
      return
    }
    setModerating(true)
    const patch = { resolved: moderatorResolved }
    if (moderatorComment.trim()) {
      patch.comment = moderatorComment.trim()
    }
    try {
      const updated = await moderateReport(reportId, patch)
      setReport(updated)
      setModeratorComment('')
      success('Report moderated.')
    } catch {
      toastError('Failed to moderate the report. Please try again.')
    } finally {
      setModerating(false)
    }
  }

  async function handleDelete() {
    if (deleting) {
      return
    }
    if (!window.confirm('Delete this report? This cannot be undone.')) {
      return
    }
    setDeleting(true)
    try {
      await deleteReport(reportId)
    } catch {
      toastError('Failed to delete the report. Please try again.')
      setDeleting(false)
      return
    }
    success('Report deleted.')
    navigate('/reports')
  }

  if (!isEditMode) {
    const submitDisabled = !description.trim() || submitting
    return (
      <section className="report-form-page">
        <form className="report-form-card" onSubmit={handleCreateSubmit}>
          <h1>
            <MessageSquareWarning size={20} />
            New Report
          </h1>

          <label htmlFor="report-type">Type</label>
          <select id="report-type" value={reportType} onChange={(event) => setReportType(event.target.value)}>
            {REPORT_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <label htmlFor="report-link">Link (optional)</label>
          <input
            id="report-link"
            type="text"
            value={link}
            onChange={(event) => setLink(event.target.value)}
            maxLength={MAX_LINK_LENGTH}
          />

          <label htmlFor="report-description">Description</label>
          <textarea
            id="report-description"
            rows={5}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={MAX_TEXT_LENGTH}
            required
          />

          <button type="submit" className="report-form-submit" disabled={submitDisabled}>
            {submitting ? 'Submitting...' : 'Submit Report'}
          </button>
        </form>
      </section>
    )
  }

  return (
    <section className="report-form-page">
      <div className="report-form-card">
        <h1>
          <MessageSquareWarning size={20} />
          Report #{report.id}
        </h1>

        <div className="report-form-meta">
          <span className={`report-form-status${report.resolved ? ' report-form-status-resolved' : ''}`}>
            {report.resolved ? 'Resolved' : 'Open'}
          </span>
          <span className="report-form-type">{report.reportType}</span>
        </div>

        <dl className="report-form-details">
          {report.link && (
            <>
              <dt>Link</dt>
              <dd>
                <a href={report.link} target="_blank" rel="noopener noreferrer">
                  {report.link}
                </a>
              </dd>
            </>
          )}
          <dt>Reported by</dt>
          <dd>{report.reporter?.displayName || report.reporter?.username || 'Unknown'}</dd>
          {report.reportedUser?.userId != null && (
            <>
              <dt>Reported user</dt>
              <dd>{report.reportedUser.displayName || report.reportedUser.username}</dd>
            </>
          )}
          {report.videoId != null && (
            <>
              <dt>Video id</dt>
              <dd>{report.videoId}</dd>
            </>
          )}
          {report.playlistId != null && (
            <>
              <dt>Playlist id</dt>
              <dd>{report.playlistId}</dd>
            </>
          )}
          <dt>Filed</dt>
          <dd>{new Date(report.createdAt).toLocaleString()}</dd>
        </dl>

        {isOwner ? (
          <form onSubmit={handleOwnerSave}>
            <label htmlFor="report-description">Description</label>
            <textarea
              id="report-description"
              rows={5}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={MAX_TEXT_LENGTH}
              disabled={report.resolved}
              required
            />
            {!report.resolved && (
              <button type="submit" className="report-form-submit" disabled={submitting}>
                {submitting ? 'Saving...' : 'Save Changes'}
              </button>
            )}
          </form>
        ) : (
          <>
            <label>Description</label>
            <p className="report-form-description-text">{report.description}</p>
          </>
        )}

        {(report.comment || report.commenter?.userId != null) && (
          <div className="report-form-comment">
            <label>Moderator comment</label>
            <p>{report.comment}</p>
            {report.commenter?.username && (
              <p className="report-form-hint">
                — {report.commenter.displayName || report.commenter.username}
              </p>
            )}
          </div>
        )}

        {canClose && (
          <button type="button" className="report-form-close" onClick={handleClose} disabled={closing}>
            {closing ? 'Closing...' : 'Close Report'}
          </button>
        )}

        {isModerator && (
          <form className="report-form-moderate" onSubmit={handleModerate}>
            <h2>Moderation</h2>
            <label className="report-form-checkbox">
              <input
                type="checkbox"
                checked={moderatorResolved}
                onChange={(event) => setModeratorResolved(event.target.checked)}
              />
              Resolved
            </label>
            <label htmlFor="report-moderator-comment">Comment</label>
            <textarea
              id="report-moderator-comment"
              rows={3}
              value={moderatorComment}
              onChange={(event) => setModeratorComment(event.target.value)}
              maxLength={MAX_TEXT_LENGTH}
            />
            <button type="submit" className="report-form-submit" disabled={moderating}>
              {moderating ? 'Saving...' : 'Save Moderation'}
            </button>
          </form>
        )}

        {isAdmin && (
          <button type="button" className="report-form-delete" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Deleting...' : 'Delete Report'}
          </button>
        )}
      </div>
    </section>
  )
}

export default ReportForm
