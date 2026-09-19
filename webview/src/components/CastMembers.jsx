import { Crown, UserRound, UserX } from 'lucide-react'
import apiClient from '../api/client.js'
import { useCast } from '../context/useCast.js'
import { useToast } from '../context/useToast.js'
import './CastMembers.css'

/**
 * The CAST session's member roster: avatar, name, owner badge, and an
 * online/offline dot sourced from the live `presence` list (distinct from
 * the durable `members` list itself - a member can be a durable participant
 * without currently having a live socket connected). The owner sees a kick
 * button on every other member.
 */
function CastMembers() {
  const { members, presence, isOwner, kickMember } = useCast()
  const { error: toastError } = useToast()

  const onlineUserIds = new Set(presence.map((entry) => entry.userId))

  async function handleKick(member) {
    if (!window.confirm(`Remove ${member.displayName || member.username} from this session?`)) {
      return
    }
    try {
      await kickMember(member.userId)
    } catch (err) {
      toastError(err.message || 'Failed to remove member.')
    }
  }

  return (
    <div className="cast-members">
      <p className="cast-members-title">Members ({members.length})</p>
      <ul className="cast-members-list">
        {members.map((member) => {
          const avatarUrl = member.avatarFilename
            ? `${apiClient.defaults.baseURL}/api/v1/users/${member.username}/avatar`
            : null
          const name = member.displayName || member.username || 'Someone'
          return (
            <li key={member.userId} className="cast-member-row">
              <span className="cast-member-avatar-wrap">
                {avatarUrl ? (
                  <img className="cast-member-avatar" src={avatarUrl} alt="" />
                ) : (
                  <span className="cast-member-avatar cast-member-avatar-placeholder">
                    <UserRound size={16} />
                  </span>
                )}
                <span
                  className={`cast-member-dot${onlineUserIds.has(member.userId) ? ' cast-member-dot-online' : ''}`}
                  title={onlineUserIds.has(member.userId) ? 'Online' : 'Offline'}
                />
              </span>
              <span className="cast-member-name">{name}</span>
              {member.role === 'owner' && (
                <Crown size={14} className="cast-member-owner-icon" aria-label="Owner" />
              )}
              {isOwner && member.role !== 'owner' && (
                <button
                  type="button"
                  className="cast-member-kick"
                  onClick={() => handleKick(member)}
                  aria-label={`Remove ${name}`}
                  title={`Remove ${name}`}
                >
                  <UserX size={14} />
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export default CastMembers
