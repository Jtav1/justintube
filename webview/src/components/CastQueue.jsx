import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Pause, Play, SkipBack, SkipForward, Square, X } from 'lucide-react'
import { suggestSearch } from '../api/search.js'
import { useCast } from '../context/useCast.js'
import { useToast } from '../context/useToast.js'
import VideoCard from './VideoCard.jsx'
import './CastQueue.css'

const SUGGESTION_LIMIT = 8
const DEBOUNCE_MS = 250

/**
 * The CAST session's live queue rail: now-playing, up-next list (with
 * per-item remove/reorder — every member can use these, per the session's
 * shared-control model), playback transport, a debounced "add a video"
 * search, and an owner-only "End session" action.
 */
function CastQueue() {
  const {
    session,
    nowPlaying,
    queue,
    playback,
    isOwner,
    addToQueue,
    removeFromQueue,
    moveInQueue,
    play,
    pause,
    skip,
    previous,
    endActiveSession,
  } = useCast()
  const { error: toastError } = useToast()

  const [addValue, setAddValue] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [suggestOpen, setSuggestOpen] = useState(false)
  const debounceRef = useRef(null)

  const trimmedAddValue = addValue.trim()
  // Adjusted during render (not an effect) so clearing the input closes the
  // dropdown immediately - same pattern as SearchAutocomplete.
  const [clearedFor, setClearedFor] = useState(null)
  if (!trimmedAddValue && clearedFor !== addValue) {
    setClearedFor(addValue)
    setSuggestions([])
    setSuggestOpen(false)
  }

  useEffect(() => {
    const trimmed = addValue.trim()
    if (!trimmed) {
      return undefined
    }

    let cancelled = false
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await suggestSearch(trimmed, { limit: SUGGESTION_LIMIT })
        if (!cancelled) {
          setSuggestions(data.items)
          setSuggestOpen(true)
        }
      } catch {
        if (!cancelled) setSuggestions([])
      }
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(debounceRef.current)
    }
  }, [addValue])

  async function handleAddSuggestion(suggestion) {
    setAddValue('')
    setSuggestions([])
    setSuggestOpen(false)
    try {
      await addToQueue(suggestion.videoId)
    } catch (err) {
      toastError(err.message || 'Failed to add video.')
    }
  }

  async function handleRemove(item) {
    try {
      await removeFromQueue(item.id)
    } catch (err) {
      toastError(err.message || 'Failed to remove video.')
    }
  }

  async function handleMove(item, direction) {
    const currentIndex = queue.findIndex((entry) => entry.id === item.id)
    if (currentIndex === -1) return
    try {
      await moveInQueue(item.id, currentIndex + direction)
    } catch (err) {
      toastError(err.message || 'Failed to reorder the queue.')
    }
  }

  async function handleTogglePlayback() {
    try {
      await (playback.status === 'playing' ? pause() : play())
    } catch (err) {
      toastError(err.message || 'Playback control failed.')
    }
  }

  async function handleSkip() {
    try {
      await skip()
    } catch (err) {
      toastError(err.message || 'Failed to skip.')
    }
  }

  async function handlePrevious() {
    try {
      await previous()
    } catch (err) {
      toastError(err.message || 'Failed to go back.')
    }
  }

  async function handleEndSession() {
    if (!window.confirm('End this CAST session for everyone?')) {
      return
    }
    try {
      await endActiveSession()
    } catch (err) {
      toastError(err.message || 'Failed to end the session.')
    }
  }

  return (
    <aside className="cast-queue">
      <div className="cast-queue-header">
        <div className="cast-queue-header-row">
          <p className="cast-queue-title">{session?.title || 'CAST session'}</p>
          {isOwner && (
            <button
              type="button"
              className="cast-queue-end"
              onClick={handleEndSession}
              aria-label="End session"
              title="End session"
            >
              <Square size={16} />
            </button>
          )}
        </div>
        <p className="cast-queue-meta">
          Code <code>{session?.code}</code>
        </p>
      </div>

      <div className="cast-queue-controls">
        <button
          type="button"
          className="cast-queue-transport"
          onClick={handlePrevious}
          aria-label="Previous"
          title="Previous"
        >
          <SkipBack size={18} />
        </button>
        <button
          type="button"
          className="cast-queue-transport cast-queue-transport-primary"
          onClick={handleTogglePlayback}
          aria-label={playback.status === 'playing' ? 'Pause' : 'Play'}
          title={playback.status === 'playing' ? 'Pause' : 'Play'}
        >
          {playback.status === 'playing' ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button
          type="button"
          className="cast-queue-transport"
          onClick={handleSkip}
          aria-label="Skip"
          title="Skip"
        >
          <SkipForward size={18} />
        </button>
      </div>

      {nowPlaying && (
        <div className="cast-queue-now-playing">
          <p className="cast-queue-section-label">Now playing</p>
          <VideoCard video={nowPlaying.video} orientation="horizontal" active hideMenu />
        </div>
      )}

      <div className="cast-queue-add">
        <input
          type="text"
          className="cast-queue-add-input"
          placeholder="Add a video…"
          value={addValue}
          onChange={(event) => setAddValue(event.target.value)}
          onFocus={() => suggestions.length > 0 && setSuggestOpen(true)}
          aria-label="Search for a video to add"
        />
        {suggestOpen && suggestions.length > 0 && (
          <ul className="cast-queue-add-dropdown">
            {suggestions.map((suggestion) => (
              <li key={suggestion.id}>
                <button type="button" onClick={() => handleAddSuggestion(suggestion)}>
                  <span className="cast-queue-add-dropdown-title">{suggestion.title}</span>
                  {suggestion.uploader && (
                    <span className="cast-queue-add-dropdown-meta">
                      {suggestion.uploader.displayName || suggestion.uploader.username}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="cast-queue-section-label">
        Up next {queue.length > 0 && `(${queue.length})`}
      </p>
      <div className="cast-queue-list">
        {queue.length === 0 && <p className="cast-queue-empty">The queue is empty.</p>}
        {queue.map((item, index) => (
          <div key={item.id} className="cast-queue-item">
            <VideoCard video={item.video} orientation="horizontal" hideMenu />
            <div className="cast-queue-item-actions">
              <button
                type="button"
                disabled={index === 0}
                onClick={() => handleMove(item, -1)}
                aria-label="Move up"
                title="Move up"
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                disabled={index === queue.length - 1}
                onClick={() => handleMove(item, 1)}
                aria-label="Move down"
                title="Move down"
              >
                <ArrowDown size={14} />
              </button>
              <button
                type="button"
                onClick={() => handleRemove(item)}
                aria-label="Remove from queue"
                title="Remove from queue"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}

export default CastQueue
