import { useEffect, useState } from 'react'
import { Pencil } from 'lucide-react'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import { adminEndCastSession, adminListCastSessions } from '../api/admin.js'
import { renameCastSession } from '../api/cast.js'
import { formatRelativeDate } from '../lib/format.js'
import './AdminCastSessions.css'

/**
 * Admin-only overview of every active CAST session, with the ability to end
 * any of them regardless of who owns it. Authorization is enforced server-side
 * by requireAdmin on /admin/cast/sessions; the check here only keeps the page
 * from rendering a table it could never fill.
 */
function AdminCastSessions() {
  const { user, loading: authLoading } = useAuth()
  const { success, error: toastError } = useToast()

  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [endingId, setEndingId] = useState(null)
  const [renamingId, setRenamingId] = useState(null)
  const [titleDraft, setTitleDraft] = useState('')

  const isAdmin = Boolean(user && user.role === 'admin')

  // Bumped after an end succeeds, to re-run the load effect below rather than
  // duplicating the fetch in the click handler.
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    if (authLoading || !isAdmin) {
      return undefined
    }
    let cancelled = false
    async function loadSessions() {
      try {
        const data = await adminListCastSessions()
        if (!cancelled) {
          setSessions(data.items ?? [])
        }
      } catch {
        if (!cancelled) {
          toastError('Failed to load active CAST sessions.')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }
    loadSessions()
    return () => {
      cancelled = true
    }
    // toastError omitted: a context function whose identity changes on every
    // ToastProvider render, which would re-run this effect endlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, isAdmin, refreshKey])

  async function handleRenameSubmit(event) {
    event.preventDefault()
    const title = titleDraft.trim()
    if (!title || renamingId == null) {
      return
    }
    try {
      await renameCastSession(renamingId, title)
      setRenamingId(null)
      setRefreshKey((key) => key + 1)
    } catch {
      toastError('Failed to rename the session.')
    }
  }

  async function handleEnd(session) {
    const label = session.title || `session ${session.code}`
    if (!window.confirm(`End "${label}"? This disconnects all participants immediately.`)) {
      return
    }
    setEndingId(session.id)
    try {
      await adminEndCastSession(session.id)
      success(`Ended "${label}".`)
      setRefreshKey((key) => key + 1)
    } catch {
      toastError(`Failed to end "${label}".`)
    } finally {
      setEndingId(null)
    }
  }

  if (authLoading) {
    return (
      <section className="settings-page">
        <p className="settings-status">Loading...</p>
      </section>
    )
  }

  if (!isAdmin) {
    return (
      <section className="settings-page">
        <p className="settings-status settings-status-error">
          You are not authorized to view this page.
        </p>
      </section>
    )
  }

  return (
    <section className="settings-page">
      <div className="settings-card admin-cast-card">
        <h1>Active CAST Sessions</h1>
        <p className="admin-cast-intro">
          Every shared watch session currently running. Ending one disconnects everybody
          watching it.
        </p>

        {loading && <p className="settings-status">Loading sessions...</p>}

        {!loading && sessions.length === 0 && (
          <p className="settings-status">There are no active CAST sessions.</p>
        )}

        {!loading && sessions.length > 0 && (
          <div className="admin-cast-table-wrap">
            <table className="admin-cast-table">
              <thead>
                <tr>
                  <th className="admin-cast-wrap">Session</th>
                  <th>Code</th>
                  <th>Owner</th>
                  <th>Watching</th>
                  <th className="admin-cast-wrap">Now playing</th>
                  <th>Started</th>
                  <th className="admin-cast-actions" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id}>
                    <td className="admin-cast-wrap">
                      {renamingId === session.id ? (
                        <form className="admin-cast-rename" onSubmit={handleRenameSubmit}>
                          <input
                            type="text"
                            value={titleDraft}
                            onChange={(event) => setTitleDraft(event.target.value)}
                            maxLength={255}
                            aria-label="Session name"
                            autoFocus
                          />
                          <button type="submit" disabled={!titleDraft.trim()}>
                            Save
                          </button>
                          <button type="button" onClick={() => setRenamingId(null)}>
                            Cancel
                          </button>
                        </form>
                      ) : (
                        <span className="admin-cast-title">
                          {session.title || '—'}
                          <button
                            type="button"
                            className="admin-cast-rename-btn"
                            aria-label={`Rename ${session.title || session.code}`}
                            title="Rename session"
                            onClick={() => {
                              setTitleDraft(session.title ?? '')
                              setRenamingId(session.id)
                            }}
                          >
                            <Pencil size={14} />
                          </button>
                        </span>
                      )}
                    </td>
                    <td>
                      <code className="admin-cast-code">{session.code}</code>
                    </td>
                    <td>
                      {session.owner
                        ? session.owner.displayName || session.owner.username
                        : '—'}
                    </td>
                    <td>{session.memberCount}</td>
                    <td className="admin-cast-wrap">{session.nowPlayingTitle || '—'}</td>
                    <td>{formatRelativeDate(session.createdAt)}</td>
                    <td className="admin-cast-actions">
                      <button
                        type="button"
                        className="admin-cast-end"
                        disabled={endingId === session.id}
                        onClick={() => handleEnd(session)}
                      >
                        {endingId === session.id ? 'Ending…' : 'End'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}

export default AdminCastSessions
