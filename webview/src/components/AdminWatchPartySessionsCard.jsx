import { useEffect, useState } from 'react'
import { Pencil } from 'lucide-react'
import { useToast } from '../context/useToast.js'
import { adminEndWatchParty, adminListWatchParties } from '../api/admin.js'
import { renameWatchParty } from '../api/watch-party.js'
import { formatRelativeDate } from '../lib/format.js'
import './AdminWatchPartySessionsCard.css'

/**
 * Admin Panel card listing every active Watch Party, with the ability to
 * stop (which also removes it from this list - "active" is the only status
 * adminListWatchParties returns) or rename any of them regardless of owner.
 * Authorization is enforced server-side by requireAdmin on
 * /admin/cast/sessions; AdminPanel itself already gates the whole page to
 * admins before this card is ever mounted.
 */
function AdminWatchPartySessionsCard() {
  const { success, error: toastError } = useToast()

  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [endingId, setEndingId] = useState(null)
  const [renamingId, setRenamingId] = useState(null)
  const [titleDraft, setTitleDraft] = useState('')

  // Bumped after a stop succeeds, to re-run the load effect below rather than
  // duplicating the fetch in the click handler.
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function loadSessions() {
      try {
        const data = await adminListWatchParties()
        if (!cancelled) {
          setSessions(data.items ?? [])
        }
      } catch {
        if (!cancelled) {
          toastError('Failed to load active Watch Parties.')
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
  }, [refreshKey])

  async function handleRenameSubmit(event) {
    event.preventDefault()
    const title = titleDraft.trim()
    if (!title || renamingId == null) {
      return
    }
    try {
      await renameWatchParty(renamingId, title)
      setRenamingId(null)
      setRefreshKey((key) => key + 1)
    } catch {
      toastError('Failed to rename the session.')
    }
  }

  async function handleStop(session) {
    const label = session.title || `session ${session.code}`
    if (
      !window.confirm(
        `Stop and delete "${label}"? This disconnects all participants immediately and removes the session.`,
      )
    ) {
      return
    }
    setEndingId(session.id)
    try {
      await adminEndWatchParty(session.id)
      success(`Stopped "${label}".`)
      setRefreshKey((key) => key + 1)
    } catch {
      toastError(`Failed to stop "${label}".`)
    } finally {
      setEndingId(null)
    }
  }

  return (
    <div className="settings-card admin-watch-party-card">
      <h2>Manage Watch Parties</h2>
      <p className="admin-watch-party-intro">
        Every shared watch session currently running. Stopping one disconnects everybody watching
        it and deletes the session.
      </p>

      {loading && <p className="settings-status">Loading sessions...</p>}

      {!loading && sessions.length === 0 && (
        <p className="settings-status">There are no active Watch Parties.</p>
      )}

      {!loading && sessions.length > 0 && (
        <div className="admin-watch-party-table-wrap">
          <table className="admin-watch-party-table">
            <thead>
              <tr>
                <th className="admin-watch-party-wrap">Session</th>
                <th>Code</th>
                <th>Owner</th>
                <th>Watching</th>
                <th className="admin-watch-party-wrap">Now playing</th>
                <th>Started</th>
                <th className="admin-watch-party-actions" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <td className="admin-watch-party-wrap">
                    {renamingId === session.id ? (
                      <form className="admin-watch-party-rename" onSubmit={handleRenameSubmit}>
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
                      <span className="admin-watch-party-title">
                        {session.title || '—'}
                        <button
                          type="button"
                          className="admin-watch-party-rename-btn"
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
                    <code className="admin-watch-party-code">{session.code}</code>
                  </td>
                  <td>
                    {session.owner
                      ? session.owner.displayName || session.owner.username
                      : '—'}
                  </td>
                  <td>{session.memberCount}</td>
                  <td className="admin-watch-party-wrap">{session.nowPlayingTitle || '—'}</td>
                  <td>{formatRelativeDate(session.createdAt)}</td>
                  <td className="admin-watch-party-actions">
                    <button
                      type="button"
                      className="admin-watch-party-end"
                      disabled={endingId === session.id}
                      onClick={() => handleStop(session)}
                    >
                      {endingId === session.id ? 'Stopping…' : 'Stop & Delete'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default AdminWatchPartySessionsCard
