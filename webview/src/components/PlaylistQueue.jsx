import { useState } from 'react'
import { Pencil, Shuffle, SkipBack, SkipForward } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/useAuth.js'
import { readPlaylistShuffleEnabled, writePlaylistShuffleEnabled } from '../lib/playlist-shuffle.js'
import VideoCard from './VideoCard.jsx'
import './PlaylistQueue.css'

/**
 * Playlist queue rail shown alongside the video player in place of
 * VideoSuggested when the current video is being watched as part of a
 * playlist. Items are newest-added-first, per the `getPlaylist` response.
 * @param {{playlist: object, currentVideoId: string, editable?: boolean, onRemoveItem?: Function}} props
 *   `playlist` is the full getPlaylist(id) response; `currentVideoId` is the
 *   public videoId of the video currently playing. When `editable` is true,
 *   each item's menu gets a "Remove from Playlist" action calling
 *   `onRemoveItem(uploadId)`.
 */
function PlaylistQueue({ playlist, currentVideoId, editable = false, onRemoveItem }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [shuffleEnabled, setShuffleEnabled] = useState(() => readPlaylistShuffleEnabled())
  const items = playlist.items ?? []
  const currentIndex = items.findIndex((item) => item.videoId === currentVideoId)

  const ownerName = playlist.owner?.displayName || playlist.owner?.username
  const canEdit = Boolean(user)
    && (String(user.id) === String(playlist.owner?.id) || user.role === 'admin')
  const canSkipBack = currentIndex > 0
  // Shuffle can jump forward from anywhere (any other item is fair game);
  // in-order mode still requires an actual next item to advance to.
  const canSkipForward = shuffleEnabled
    ? items.length > 1
    : currentIndex !== -1 && currentIndex < items.length - 1

  function goToIndex(index) {
    const target = items[index]
    if (target) {
      navigate(`/video?v=${target.videoId}&list=${playlist.id}`)
    }
  }

  function handleToggleShuffle() {
    setShuffleEnabled((prev) => {
      const next = !prev
      writePlaylistShuffleEnabled(next)
      return next
    })
  }

  // Picks a random item other than the one currently playing (when possible)
  // so shuffling always moves you somewhere new.
  function handleSkipForward() {
    if (!shuffleEnabled) {
      goToIndex(currentIndex + 1)
      return
    }
    if (items.length < 2) {
      return
    }
    let index = Math.floor(Math.random() * items.length)
    if (index === currentIndex) {
      index = (index + 1) % items.length
    }
    goToIndex(index)
  }

  return (
    <aside className="playlist-queue">
      <div className="playlist-queue-header">
        <div className="playlist-queue-header-row">
          <p className="playlist-queue-title">{playlist.name}</p>
          {canEdit && (
            <Link
              to={`/playlists/${playlist.id}/edit`}
              className="playlist-queue-edit"
              aria-label="Edit playlist"
              title="Edit playlist"
            >
              <Pencil size={16} />
            </Link>
          )}
        </div>
        {ownerName && (
          <p className="playlist-queue-meta">
            <Link to={`/users/${playlist.owner.username}`}>{ownerName}</Link>
          </p>
        )}
        <p className="playlist-queue-meta">
          {items.length} {items.length === 1 ? 'video' : 'videos'}
        </p>
      </div>
      <div className="playlist-queue-controls">
        <button
          type="button"
          className="playlist-queue-skip"
          disabled={!canSkipBack}
          onClick={() => goToIndex(currentIndex - 1)}
          aria-label="Previous video in playlist"
          title="Previous video in playlist"
        >
          <SkipBack size={18} />
        </button>
        <button
          type="button"
          className={`playlist-queue-skip${shuffleEnabled ? ' playlist-queue-skip-active' : ''}`}
          onClick={handleToggleShuffle}
          aria-label={shuffleEnabled ? 'Disable shuffle' : 'Enable shuffle'}
          title={shuffleEnabled ? 'Disable shuffle' : 'Enable shuffle'}
          aria-pressed={shuffleEnabled}
        >
          <Shuffle size={18} />
        </button>
        <button
          type="button"
          className="playlist-queue-skip"
          disabled={!canSkipForward}
          onClick={handleSkipForward}
          aria-label="Next video in playlist"
          title="Next video in playlist"
        >
          <SkipForward size={18} />
        </button>
      </div>
      <div className="playlist-queue-list">
        {items.map((item) => (
          <VideoCard
            key={item.id}
            video={item}
            orientation="horizontal"
            linkTo={`/video?v=${item.videoId}&list=${playlist.id}`}
            active={item.videoId === currentVideoId}
            onRemoveFromPlaylist={editable ? () => onRemoveItem(item.id) : undefined}
          />
        ))}
      </div>
    </aside>
  )
}

export default PlaylistQueue
