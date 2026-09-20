import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  MailCheck,
  MailWarning,
  Pencil,
  Video,
  VideoOff,
} from 'lucide-react'
import { useToast } from '../context/useToast.js'
import { adminSetUserEmailVerified, adminSetUserUploader, getAdminUsers } from '../api/users.js'
import AdminUserEditModal from './AdminUserEditModal.jsx'
import './AdminUsersCard.css'

const PAGE_LIMIT = 100
const DISPLAY_NAME_MAX_LENGTH = 50

/**
 * Truncates a display name to DISPLAY_NAME_MAX_LENGTH characters, appending
 * "..." when it was cut short.
 * @param {string} name
 * @returns {string}
 */
function truncateDisplayName(name) {
  if (name.length <= DISPLAY_NAME_MAX_LENGTH) {
    return name
  }
  return `${name.slice(0, DISPLAY_NAME_MAX_LENGTH)}...`
}

/**
 * Admin Panel card listing every user in a sortable table (by display name),
 * expandable per row for username/email/created-at, with a per-user edit
 * modal for role/avatar/banner/password management. Revoking email
 * verification or uploader access happens directly from the row's status
 * icons, gated by a confirm dialog.
 */
function AdminUsersCard() {
  const { success, error: toastError } = useToast()

  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [sortDirection, setSortDirection] = useState('asc')

  const [expandedId, setExpandedId] = useState(null)
  const [editingUser, setEditingUser] = useState(null)
  const [pendingRevokeKey, setPendingRevokeKey] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function loadUsers() {
      setLoading(true)
      try {
        let offset = 0
        let total = Infinity
        let all = []
        while (offset < total) {
          const data = await getAdminUsers({ limit: PAGE_LIMIT, offset })
          all = all.concat(data.items)
          total = data.total
          offset += data.items.length
          if (data.items.length === 0) {
            break
          }
        }
        if (!cancelled) {
          setUsers(all)
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

    loadUsers()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sortedUsers = useMemo(() => {
    const direction = sortDirection === 'asc' ? 1 : -1
    return [...users].sort((a, b) => {
      const aLabel = a.displayName || a.username
      const bLabel = b.displayName || b.username
      return aLabel.localeCompare(bLabel) * direction
    })
  }, [users, sortDirection])

  function handleToggleSort() {
    setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'))
  }

  function handleToggleExpand(userId) {
    setExpandedId((prev) => (prev === userId ? null : userId))
  }

  function patchUser(userId, patch) {
    setUsers((prev) => prev.map((item) => (item.id === userId ? { ...item, ...patch } : item)))
  }

  async function handleRevokeEmailVerified(user) {
    const label = user.displayName || user.username
    if (!window.confirm(`Revoke email verification for ${label}?`)) {
      return
    }
    const key = `${user.id}-emailVerified`
    setPendingRevokeKey(key)
    try {
      await adminSetUserEmailVerified(user.id, false)
      patchUser(user.id, { emailVerified: false })
      success('Email verification revoked.')
    } catch {
      toastError('Failed to revoke email verification.')
    } finally {
      setPendingRevokeKey(null)
    }
  }

  async function handleRevokeUploader(user) {
    const label = user.displayName || user.username
    if (!window.confirm(`Revoke uploader access for ${label}?`)) {
      return
    }
    const key = `${user.id}-uploader`
    setPendingRevokeKey(key)
    try {
      await adminSetUserUploader(user.id, false)
      patchUser(user.id, { uploader: false })
      success('Uploader access revoked.')
    } catch {
      toastError('Failed to revoke uploader access.')
    } finally {
      setPendingRevokeKey(null)
    }
  }

  function handleEditUpdated(userId, patch) {
    patchUser(userId, patch)
    setEditingUser((prev) => (prev && prev.id === userId ? { ...prev, ...patch } : prev))
  }

  return (
    <div className="settings-card admin-users-card">
      <h2>Manage Users</h2>

      {loading && <p className="settings-status">Loading users...</p>}
      {!loading && sortedUsers.length === 0 && <p className="settings-status">No users yet.</p>}

      {!loading && sortedUsers.length > 0 && (
        <table className="admin-users-table">
          <thead>
            <tr>
              <th>
                <button type="button" className="admin-users-sort-btn" onClick={handleToggleSort}>
                  Display Name
                  {sortDirection === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
                </button>
              </th>
              <th>Role</th>
              <th>Status</th>
              <th>Edit</th>
            </tr>
          </thead>
          <tbody>
            {sortedUsers.map((user) => {
              const label = user.displayName || user.username
              const expanded = expandedId === user.id
              const revokingEmail = pendingRevokeKey === `${user.id}-emailVerified`
              const revokingUploader = pendingRevokeKey === `${user.id}-uploader`
              return (
                <Fragment key={user.id}>
                  <tr className="admin-users-row">
                    <td>
                      <button
                        type="button"
                        className="admin-users-name-btn"
                        onClick={() => handleToggleExpand(user.id)}
                        aria-expanded={expanded}
                      >
                        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                        {truncateDisplayName(label)}
                      </button>
                    </td>
                    <td className="admin-users-role-cell">{user.role || '—'}</td>
                    <td>
                      <div className="admin-users-status-icons">
                        <button
                          type="button"
                          className="admin-users-status-btn"
                          disabled={!user.emailVerified || revokingEmail}
                          onClick={() => handleRevokeEmailVerified(user)}
                          aria-label={user.emailVerified ? 'Revoke email verification' : 'Email not verified'}
                          title={user.emailVerified ? 'Revoke email verification' : 'Email not verified'}
                        >
                          {user.emailVerified ? (
                            <MailCheck className="admin-users-status-icon-true" size={18} />
                          ) : (
                            <MailWarning className="admin-users-status-icon-false" size={18} />
                          )}
                        </button>
                        <button
                          type="button"
                          className="admin-users-status-btn"
                          disabled={!user.uploader || revokingUploader}
                          onClick={() => handleRevokeUploader(user)}
                          aria-label={user.uploader ? 'Revoke uploader access' : 'No uploader access'}
                          title={user.uploader ? 'Revoke uploader access' : 'No uploader access'}
                        >
                          {user.uploader ? (
                            <Video className="admin-users-status-icon-true" size={18} />
                          ) : (
                            <VideoOff className="admin-users-status-icon-false" size={18} />
                          )}
                        </button>
                      </div>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="admin-users-edit-btn"
                        onClick={() => setEditingUser(user)}
                        aria-label={`Edit ${label}`}
                        title="Edit user"
                      >
                        <Pencil size={16} />
                      </button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="admin-users-detail-row">
                      <td colSpan={4}>
                        <dl className="admin-users-detail-grid">
                          <div>
                            <dt>Username</dt>
                            <dd>{user.username}</dd>
                          </div>
                          <div>
                            <dt>Email</dt>
                            <dd>{user.email}</dd>
                          </div>
                          <div>
                            <dt>Created</dt>
                            <dd>{new Date(user.createdAt).toLocaleDateString()}</dd>
                          </div>
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      )}

      {editingUser && (
        <AdminUserEditModal
          user={editingUser}
          onClose={() => setEditingUser(null)}
          onUpdated={(patch) => handleEditUpdated(editingUser.id, patch)}
        />
      )}
    </div>
  )
}

export default AdminUsersCard
