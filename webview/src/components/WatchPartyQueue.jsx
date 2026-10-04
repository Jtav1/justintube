import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Pause, Pencil, Play, SkipBack, SkipForward, Square, X } from 'lucide-react'
import { suggestSearch } from '../api/search.js'
import { listMyPlaylists } from '../api/playlists.js'
import { useWatchParty } from '../context/useWatchParty.js'
import { useToast } from '../context/useToast.js'
import VideoCard from './VideoCard.jsx'
import ToggleSwitch from './ToggleSwitch.jsx'
import './WatchPartyQueue.css'

const SUGGESTION_LIMIT = 8
const DEBOUNCE_MS = 250

/**
 * The Watch Party's live queue rail: now-playing, up-next list (with
 * per-item remove/reorder — every member can use these, per the session's
 * shared-control model), playback transport, a debounced "add a video"
 * search, an "add a whole playlist" picker, and an owner-only "End session"
 * action.
 */
function WatchPartyQueue() {
  const {
    session,
    nowPlaying,
    queue,
    playback,
    isOwner,
    hideJoinInfo,
    setHideJoinInfo,
    addToQueue,
    addPlaylistToQueue,
    removeFromQueue,
    moveInQueue,
    play,
    pause,
    skip,
    previous,
    endActiveSession,
    canManageSession,
    renameSession,
    setAutoAdvance,
  } = useWatchParty()
  const { error: toastError, info: toastInfo } = useToast()

  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [addValue, setAddValue] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [playlists, setPlaylists] = useState([])
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('')
  const [playlistBusy, setPlaylistBusy] = useState(false)
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

  // Fetched on mount rather than when the picker is first touched: a native
  // <select> opens its list on mousedown, so loading then would show an empty
  // dropdown on the first click. This rail only renders inside a session.
  useEffect(() => {
    let cancelled = false
    listMyPlaylists({ limit: 99 })
      .then((data) => {
        if (!cancelled) setPlaylists(data.items ?? [])
      })
      .catch(() => {
        // A failed list just means no playlist shortcut - the video search above
        // still works, so this isn't worth a toast.
      })
    return () => {
      cancelled = true
    }
  }, [])

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


  /**
   * Appends the chosen playlist to the queue. The server reports how many
   * videos actually landed, which can be fewer than the playlist holds when some
   * of them aren't visible to this member - said out loud so the difference
   * doesn't look like a bug.
   *
   * @returns {Promise<void>}
   */
  async function handleAddPlaylist() {
    if (!selectedPlaylistId || playlistBusy) {
      return
    }
    setPlaylistBusy(true)
    try {
      const ack = await addPlaylistToQueue(Number(selectedPlaylistId))
      setSelectedPlaylistId('')
      const added = ack?.addedCount
      if (added === 0) {
        toastInfo('Nothing was added - none of that playlist is available to you.')
      } else if (typeof added === 'number') {
        toastInfo(`Added ${added} ${added === 1 ? 'video' : 'videos'} to the queue.`)
      }
    } catch (err) {
      toastError(err.message || 'Failed to add the playlist.')
    } finally {
      setPlaylistBusy(false)
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

  async function handleToggleAutoAdvance(enabled) {
    try {
      await setAutoAdvance(enabled)
    } catch (err) {
      toastError(err.message || 'Failed to update autoplay.')
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

  /**
   * Renames the session from the page itself. The new title comes back over
   * the socket's state:sync broadcast, so there's nothing to set locally.
   *
   * @param {import('react').FormEvent} event Submit event.
   * @returns {Promise<void>}
   */
  async function handleRenameSubmit(event) {
    event.preventDefault()
    const title = titleDraft.trim()
    if (!title || renameBusy) {
      return
    }
    setRenameBusy(true)
    try {
      await renameSession(title)
      setRenaming(false)
    } catch (err) {
      toastError(err.message || 'Failed to rename the session.')
    } finally {
      setRenameBusy(false)
    }
  }

  async function handleEndSession() {
    if (!window.confirm('End this Watch Party for everyone?')) {
      return
    }
    try {
      await endActiveSession()
    } catch (err) {
      toastError(err.message || 'Failed to end the session.')
    }
  }

  return (
    <aside className="watch-party-queue">
      <div className="watch-party-queue-header">
        <div className="watch-party-queue-header-row">
          {renaming ? (
            <form className="watch-party-queue-rename" onSubmit={handleRenameSubmit}>
              <input
                type="text"
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                maxLength={255}
                aria-label="Session name"
                autoFocus
              />
              <div className="watch-party-queue-rename-actions">
                <button type="submit" disabled={renameBusy || !titleDraft.trim()}>
                  Save
                </button>
                <button type="button" disabled={renameBusy} onClick={() => setRenaming(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <p className="watch-party-queue-title">
              {session?.title || 'Watch Party'}
              {canManageSession && (
                <button
                  type="button"
                  className="watch-party-queue-rename-btn"
                  aria-label="Rename session"
                  title="Rename session"
                  onClick={() => {
                    setTitleDraft(session?.title ?? '')
                    setRenaming(true)
                  }}
                >
                  <Pencil size={14} />
                </button>
              )}
            </p>
          )}
          {isOwner && !renaming && (
            <button
              type="button"
              className="watch-party-queue-end"
              onClick={handleEndSession}
              aria-label="End session"
              title="End session"
            >
              <Square size={16} />
            </button>
          )}
        </div>
        <p className="watch-party-queue-meta">
          Code{' '}
          {hideJoinInfo ? (
            <span className="watch-party-queue-code-masked" aria-label="Join code hidden">••••••</span>
          ) : (
            <code>{session?.code}</code>
          )}
        </p>
        <ToggleSwitch
          id="watch-party-hide-join-info"
          className="watch-party-queue-hide-join-info"
          label="Hide Join Info"
          checked={hideJoinInfo}
          onChange={setHideJoinInfo}
        />
        <ToggleSwitch
          id="watch-party-auto-advance"
          className="watch-party-queue-autoplay"
          label="Autoplay"
          checked={session?.autoAdvanceEnabled ?? true}
          disabled={!canManageSession}
          onChange={handleToggleAutoAdvance}
        />
      </div>

      <div className="watch-party-queue-controls">
        <button
          type="button"
          className="watch-party-queue-transport"
          onClick={handlePrevious}
          aria-label="Previous"
          title="Previous"
        >
          <SkipBack size={18} />
        </button>
        <button
          type="button"
          className="watch-party-queue-transport watch-party-queue-transport-primary"
          onClick={handleTogglePlayback}
          disabled={!nowPlaying}
          aria-label={playback.status === 'playing' ? 'Pause' : 'Play'}
          title={playback.status === 'playing' ? 'Pause' : 'Play'}
        >
          {playback.status === 'playing' ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button
          type="button"
          className="watch-party-queue-transport"
          onClick={handleSkip}
          aria-label="Skip"
          title="Skip"
        >
          <SkipForward size={18} />
        </button>
      </div>

      {nowPlaying && (
        <div className="watch-party-queue-now-playing">
          <p className="watch-party-queue-section-label">Now playing</p>
          <VideoCard video={nowPlaying.video} orientation="horizontal" active hideMenu />
        </div>
      )}
      {!nowPlaying && queue.length > 0 && (
        <div className="watch-party-queue-now-playing">
          <p className="watch-party-queue-section-label">Autoplay is off</p>
          <p className="watch-party-queue-meta">Use Skip above to play the next video.</p>
        </div>
      )}

      <div className="watch-party-queue-add">
        <input
          type="text"
          className="watch-party-queue-add-input"
          placeholder="Add a video…"
          value={addValue}
          onChange={(event) => setAddValue(event.target.value)}
          onFocus={() => suggestions.length > 0 && setSuggestOpen(true)}
          aria-label="Search for a video to add"
        />
        {suggestOpen && suggestions.length > 0 && (
          <ul className="watch-party-queue-add-dropdown">
            {suggestions.map((suggestion) => (
              <li key={suggestion.id}>
                <button type="button" onClick={() => handleAddSuggestion(suggestion)}>
                  <span className="watch-party-queue-add-dropdown-title">{suggestion.title}</span>
                  {suggestion.uploader && (
                    <span className="watch-party-queue-add-dropdown-meta">
                      {suggestion.uploader.displayName || suggestion.uploader.username}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="watch-party-queue-add-playlist">
        <select
          value={selectedPlaylistId}
          onChange={(event) => setSelectedPlaylistId(event.target.value)}
          aria-label="Choose a playlist to add to the queue"
        >
          <option value="">Add a playlist…</option>
          {playlists.map((playlist) => (
            <option key={playlist.id} value={playlist.id}>
              {playlist.title}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={playlistBusy || !selectedPlaylistId}
          onClick={handleAddPlaylist}
        >
          Add all
        </button>
      </div>

      <p className="watch-party-queue-section-label">
        Up next {queue.length > 0 && `(${queue.length})`}
      </p>
      <div className="watch-party-queue-list">
        {queue.length === 0 && <p className="watch-party-queue-empty">The queue is empty.</p>}
        {queue.map((item, index) => (
          <div key={item.id} className="watch-party-queue-item">
            <VideoCard video={item.video} orientation="horizontal" hideMenu />
            <div className="watch-party-queue-item-actions">
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

export default WatchPartyQueue
