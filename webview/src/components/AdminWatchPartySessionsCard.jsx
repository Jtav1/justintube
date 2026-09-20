import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Pencil, Trash2, UserRound } from 'lucide-react'
import { useToast } from '../context/useToast.js'
import {
  adminEndWatchParty,
  adminListWatchParties,
  adminListWatchPartyMembers,
} from '../api/admin.js'
import { renameWatchParty } from '../api/watch-party.js'
import { formatRelativeDate } from '../lib/format.js'
import apiClient from '../api/client.js'
import './AdminWatchPartySessionsCard.css'

/**
 * Admin Panel card listing every active Watch Party, with the ability to
 * stop (which also removes it from this list - "active" is the only status
 * adminListWatchParties returns) or rename any of them regardless of owner.
 * Each row is collapsed to its essentials (name, owner, watcher count,
 * actions) and can be expanded to reveal the join code, now-playing title,
 * start time, and the live "who is watching" roster. Authorization is
 * enforced server-side by requireAdmin on /admin/cast/sessions; AdminPanel
 * itself already gates the whole page to admins before this card is ever
 * mounted.
 */
function AdminWatchPartySessionsCard() {
  const { success, error: toastError } = useToast()

  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [endingId, setEndingId] = useState(null)
  const [renamingId, setRenamingId] = useState(null)
  const [titleDraft, setTitleDraft] = useState('')

  const [expandedId, setExpandedId] = useState(null)
  const [membersById, setMembersById] = useState({})
  const [membersLoadingId, setMembersLoadingId] = useState(null)

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

  async function handleToggleExpand(session) {
    if (expandedId === session.id) {
      setExpandedId(null)
      return
    }
    setExpandedId(session.id)
    if (membersById[session.id]) {
      return
    }
    setMembersLoadingId(session.id)
    try {
      const data = await adminListWatchPartyMembers(session.id)
      setMembersById((prev) => ({ ...prev, [session.id]: data.items ?? [] }))
    } catch {
      toastError('Failed to load who is watching.')
    } finally {
      setMembersLoadingId(null)
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
        <ul className="admin-watch-party-list">
          {sessions.map((session) => {
            const expanded = expandedId === session.id
            const members = membersById[session.id]
            return (
              <li key={session.id} className="admin-watch-party-item">
                <div className="admin-watch-party-row">
                  <button
                    type="button"
                    className="admin-watch-party-expand-btn"
                    aria-label={expanded ? 'Collapse details' : 'Expand details'}
                    aria-expanded={expanded}
                    onClick={() => handleToggleExpand(session)}
                  >
                    {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>

                  <div className="admin-watch-party-name">
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
                  </div>

                  <div className="admin-watch-party-owner">
                    {session.owner ? session.owner.displayName || session.owner.username : '—'}
                  </div>

                  <div className="admin-watch-party-watching">{session.memberCount}</div>

                  <div className="admin-watch-party-actions">
                    <button
                      type="button"
                      className="admin-watch-party-end"
                      disabled={endingId === session.id}
                      aria-label={`Stop and delete ${session.title || session.code}`}
                      title="Stop & delete"
                      onClick={() => handleStop(session)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>

                {expanded && (
                  <div className="admin-watch-party-details">
                    <dl className="admin-watch-party-detail-grid">
                      <div>
                        <dt>Code</dt>
                        <dd>
                          <code className="admin-watch-party-code">{session.code}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Now playing</dt>
                        <dd>{session.nowPlayingTitle || '—'}</dd>
                      </div>
                      <div>
                        <dt>Started</dt>
                        <dd>{formatRelativeDate(session.createdAt)}</dd>
                      </div>
                    </dl>

                    <div className="admin-watch-party-who">
                      <p className="admin-watch-party-who-title">Who is watching</p>
                      {membersLoadingId === session.id && (
                        <p className="settings-status">Loading…</p>
                      )}
                      {membersLoadingId !== session.id && members?.length === 0 && (
                        <p className="settings-status">Nobody is currently watching.</p>
                      )}
                      {membersLoadingId !== session.id && members?.length > 0 && (
                        <ul className="admin-watch-party-who-list">
                          {members.map((member) => {
                            const avatarUrl = member.avatarFilename
                              ? `${apiClient.defaults.baseURL}/api/v1/users/${member.username}/avatar`
                              : null
                            const name = member.displayName || member.username || 'Someone'
                            return (
                              <li key={member.userId} className="admin-watch-party-who-row">
                                {avatarUrl ? (
                                  <img
                                    className="admin-watch-party-who-avatar"
                                    src={avatarUrl}
                                    alt=""
                                  />
                                ) : (
                                  <span className="admin-watch-party-who-avatar admin-watch-party-who-avatar-placeholder">
                                    <UserRound size={14} />
                                  </span>
                                )}
                                <span className="admin-watch-party-who-name">{name}</span>
                                {member.role === 'owner' && (
                                  <span className="admin-watch-party-who-owner">Owner</span>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export default AdminWatchPartySessionsCard
