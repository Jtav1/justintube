import { Link } from 'react-router-dom'
import { MailCheck, MailWarning, UserRound, Video, VideoOff } from 'lucide-react'
import { useAuth } from '../context/useAuth.js'
import apiClient from '../api/client.js'
import './UserCard.css'

function UserCard({ user }) {
  const { user: authUser } = useAuth()
  const isAdminViewer = authUser?.role === 'admin'

  const avatarUrl = user.avatarFilename
    ? `${apiClient.defaults.baseURL}/api/v1/users/${user.username}/avatar`
    : null
  const showStatusIcons = isAdminViewer && user.emailVerified !== undefined

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
    </Link>
  )
}

export default UserCard
