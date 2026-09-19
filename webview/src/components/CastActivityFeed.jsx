import { useEffect, useRef } from 'react'
import { formatRelativeDate } from '../lib/format.js'
import { useCast } from '../context/useCast.js'
import './CastActivityFeed.css'

/**
 * Scrolling feed of session activity (joins, kicks, queue changes, skips,
 * reactions) sourced from `useCast().activity`, which the CastContext socket
 * listener appends to as `activity`/`react` events arrive. Auto-scrolls to
 * the newest entry.
 */
function CastActivityFeed() {
  const { activity } = useCast()
  const listRef = useRef(null)

  useEffect(() => {
    const el = listRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [activity])

  return (
    <div className="cast-activity">
      <p className="cast-activity-title">Activity</p>
      <ul className="cast-activity-list" ref={listRef}>
        {activity.length === 0 && <li className="cast-activity-empty">Nothing yet.</li>}
        {activity.map((entry, index) => (
          <li key={`${entry.at}-${index}`} className="cast-activity-item">
            {entry.type === 'reaction' ? (
              <span>
                <strong>{entry.actorName}</strong> reacted {entry.emoji}
              </span>
            ) : (
              <span>{entry.text}</span>
            )}
            <span className="cast-activity-time">{formatRelativeDate(entry.at)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default CastActivityFeed
