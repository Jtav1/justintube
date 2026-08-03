import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { MailCheck, MailWarning, UserRound, Video, VideoOff } from 'lucide-react'
import { useAuth } from '../context/useAuth.js'
import apiClient from '../api/client.js'
import { adminUpdateUserRole, getSubscriptionState, subscribeToUser, unsubscribeFromUser } from '../api/users.js'
import { USER_ROLES } from '../lib/roles.js'
import './UserCard.css'

function UserCard({ user }) {
  const { user: authUser } = useAuth()
  const isAdminViewer = authUser?.role === 'admin'

  const [role, setRole] = useState(user.role)
  const [updatingRole, setUpdatingRole] = useState(false)
  const [subscribed, setSubscribed] = useState(null)
  const [subscribePending, setSubscribePending] = useState(false)

  const avatarUrl = user.avatarFilename
    ? `${apiClient.defaults.baseURL}/api/v1/users/${user.username}/avatar`
    : null
  const showStatusIcons = isAdminViewer && user.emailVerified !== undefined
  const showRoleSelect = isAdminViewer && role !== undefined
  const canSubscribe = Boolean(authUser) && authUser.id !== user.id

  async function handleRoleChange(event) {
    const nextRole = event.target.value
    const previousRole = role
    setRole(nextRole)
    setUpdatingRole(true)
    try {
      await adminUpdateUserRole(user.id, nextRole)
    } catch {
      setRole(previousRole)
    } finally {
      setUpdatingRole(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    setSubscribed(null)

    if (!canSubscribe) {
      return undefined
    }

    getSubscriptionState(user.id)
      .then((data) => {
        if (!cancelled) {
          setSubscribed(data.subscribed)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSubscribed(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [canSubscribe, user.id])

  async function handleToggleSubscribe(event) {
    event.preventDefault()
    if (subscribePending || subscribed === null) {
      return
    }
    setSubscribePending(true)
    try {
      const result = subscribed
        ? await unsubscribeFromUser(user.id)
        : await subscribeToUser(user.id)
      setSubscribed(result.subscribed)
    } catch (err) {
      console.error('Failed to update subscription:', err)
    } finally {
      setSubscribePending(false)
    }
  }

  return (
    <Link to={`/users/${user.username}`} className="user-card">
      {avatarUrl ? (
        <img className="user-card-avatar" src={avatarUrl} alt="" />
      ) : (
        <span className="user-card-avatar user-card-avatar-placeholder">
          <UserRound size={44} />
        </span>
      )}
      <div className="user-card-identity">
        <p className="user-card-name">
          {user.displayName || user.username}
          {user.displayName && (
            <span className="user-card-handle"> ({user.username})</span>
          )}
        </p>
        <p className="user-card-uploads">
          {user.uploadCount} {user.uploadCount === 1 ? 'upload' : 'uploads'}
        </p>
      </div>
      <p className="user-card-bio">
        {user.bio || <em>No bio yet.</em>}
      </p>
      {canSubscribe && (
        <button
          type="button"
          className={`user-card-subscribe-btn${subscribed ? ' user-card-subscribe-btn-active' : ''}`}
          disabled={subscribed === null || subscribePending}
          onClick={handleToggleSubscribe}
        >
          {subscribed ? 'Unsubscribe' : 'Subscribe'}
        </button>
      )}
      {showStatusIcons && (
        <div className="user-card-status-icons">
          {user.emailVerified ? (
            <MailCheck className="user-card-status-icon-true" size={20} aria-label="Email verified" />
          ) : (
            <MailWarning className="user-card-status-icon-false" size={20} aria-label="Email not verified" />
          )}
          {user.uploader ? (
            <Video className="user-card-status-icon-true" size={20} aria-label="Uploader access granted" />
          ) : (
            <VideoOff className="user-card-status-icon-false" size={20} aria-label="No uploader access" />
          )}
        </div>
      )}
      {showRoleSelect && (
        <label
          className="user-card-role-select"
          onClick={(event) => event.preventDefault()}
        >
          Role
          <select value={role} disabled={updatingRole} onChange={handleRoleChange}>
            {USER_ROLES.map((roleOption) => (
              <option key={roleOption} value={roleOption}>
                {roleOption}
              </option>
            ))}
          </select>
        </label>
      )}
    </Link>
  )
}

export default UserCard
