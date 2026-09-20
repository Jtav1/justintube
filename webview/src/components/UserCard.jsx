import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { UserRound } from 'lucide-react'
import { useAuth } from '../context/useAuth.js'
import apiClient from '../api/client.js'
import { getSubscriptionState, subscribeToUser, unsubscribeFromUser } from '../api/users.js'
import './UserCard.css'

function UserCard({ user }) {
  const { user: authUser } = useAuth()

  const [subscribed, setSubscribed] = useState(null)
  const [subscribePending, setSubscribePending] = useState(false)

  const avatarUrl = user.avatarFilename
    ? `${apiClient.defaults.baseURL}/api/v1/users/${user.username}/avatar`
    : null
  const canSubscribe = Boolean(authUser) && authUser.id !== user.id

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
    </Link>
  )
}

export default UserCard
