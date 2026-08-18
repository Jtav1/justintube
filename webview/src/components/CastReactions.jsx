import { useEffect, useRef, useState } from 'react'
import { useCast } from '../context/useCast.js'
import './CastReactions.css'

const FLOAT_DURATION_MS = 2500

let floatIdCounter = 0

/**
 * Floating emoji overlay: watches `useCast().activity` for newly-appended
 * `reaction` entries (skipping whatever was already in the feed at mount, so
 * reopening this component doesn't replay history) and spawns a transient,
 * self-removing floating node for each one. Meant to sit absolutely
 * positioned over the video player.
 */
function CastReactions() {
  const { activity } = useCast()
  const [floats, setFloats] = useState([])
  const seenCountRef = useRef(activity.length)

  useEffect(() => {
    if (activity.length <= seenCountRef.current) {
      seenCountRef.current = activity.length
      return
    }

    const newReactions = activity
      .slice(seenCountRef.current)
      .filter((entry) => entry.type === 'reaction')
    seenCountRef.current = activity.length
    if (newReactions.length === 0) {
      return
    }

    const additions = newReactions.map((entry) => ({
      id: (floatIdCounter += 1),
      emoji: entry.emoji,
      left: 10 + Math.random() * 80,
    }))
    setFloats((prev) => [...prev, ...additions])

    for (const addition of additions) {
      setTimeout(() => {
        setFloats((prev) => prev.filter((float) => float.id !== addition.id))
      }, FLOAT_DURATION_MS)
    }
  }, [activity])

  return (
    <div className="cast-reactions" aria-hidden="true">
      {floats.map((float) => (
        <span key={float.id} className="cast-reaction-float" style={{ left: `${float.left}%` }}>
          {float.emoji}
        </span>
      ))}
    </div>
  )
}

export default CastReactions
