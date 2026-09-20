import { Crown, UserRound, UserX } from 'lucide-react'
import apiClient from '../api/client.js'
import { useWatchParty } from '../context/useWatchParty.js'
import { useToast } from '../context/useToast.js'
import './WatchPartyMembers.css'

/**
 * The Watch Party's member roster: avatar, name, owner badge, and an
 * online/offline dot sourced from the live `presence` list (distinct from
 * the durable `members` list itself - a member can be a durable participant
 * without currently having a live socket connected). The owner sees a kick
 * button on every other member.
 */
function WatchPartyMembers() {
  const { members, presence, isOwner, kickMember } = useWatchParty()
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
    <div className="watch-party-members">
      <p className="watch-party-members-title">Members ({members.length})</p>
      <ul className="watch-party-members-list">
        {members.map((member) => {
          const avatarUrl = member.avatarFilename
            ? `${apiClient.defaults.baseURL}/api/v1/users/${member.username}/avatar`
            : null
          const name = member.displayName || member.username || 'Someone'
          return (
            <li key={member.userId} className="watch-party-member-row">
              <span className="watch-party-member-avatar-wrap">
                {avatarUrl ? (
                  <img className="watch-party-member-avatar" src={avatarUrl} alt="" />
                ) : (
                  <span className="watch-party-member-avatar watch-party-member-avatar-placeholder">
                    <UserRound size={16} />
                  </span>
                )}
                <span
                  className={`watch-party-member-dot${onlineUserIds.has(member.userId) ? ' watch-party-member-dot-online' : ''}`}
                  title={onlineUserIds.has(member.userId) ? 'Online' : 'Offline'}
                />
              </span>
              <span className="watch-party-member-name">{name}</span>
              {member.role === 'owner' && (
                <Crown size={14} className="watch-party-member-owner-icon" aria-label="Owner" />
              )}
              {isOwner && member.role !== 'owner' && (
                <button
                  type="button"
                  className="watch-party-member-kick"
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

export default WatchPartyMembers
