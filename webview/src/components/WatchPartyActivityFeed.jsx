import { useEffect, useRef } from 'react'
import { formatRelativeDate } from '../lib/format.js'
import { useWatchParty } from '../context/useWatchParty.js'
import './WatchPartyActivityFeed.css'

/**
 * Scrolling feed of session activity (joins, kicks, queue changes, skips,
 * reactions) sourced from `useWatchParty().activity`, which the
 * WatchPartyContext socket listener appends to as `activity`/`react` events
 * arrive. Auto-scrolls to the newest entry.
 */
function WatchPartyActivityFeed() {
  const { activity } = useWatchParty()
  const listRef = useRef(null)

  useEffect(() => {
    const el = listRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [activity])

  return (
    <div className="watch-party-activity">
      <p className="watch-party-activity-title">Activity</p>
      <ul className="watch-party-activity-list" ref={listRef}>
        {activity.length === 0 && <li className="watch-party-activity-empty">Nothing yet.</li>}
        {activity.map((entry, index) => (
          <li key={`${entry.at}-${index}`} className="watch-party-activity-item">
            {entry.type === 'reaction' ? (
              <span>
                <strong>{entry.actorName}</strong> reacted {entry.emoji}
              </span>
            ) : (
              <span>{entry.text}</span>
            )}
            <span className="watch-party-activity-time">{formatRelativeDate(entry.at)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default WatchPartyActivityFeed
