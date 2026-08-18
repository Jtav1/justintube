import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Play, UserRound } from 'lucide-react'
import apiClient from '../api/client.js'
import { getPlaylist } from '../api/playlists.js'
import { formatRelativeDate } from '../lib/format.js'
import { useToast } from '../context/useToast.js'
import VideoCard from '../components/VideoCard.jsx'
import './PlaylistPage.css'

/**
 * Read-only playlist overview: name/creator/description/visibility/stats up
 * top (mirroring VideoPlayer's info block), a Play button that jumps to the
 * playlist's first video (same target PlaylistCard's thumbnail links to),
 * and every video in the playlist, in order, below.
 */
function PlaylistPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { error: toastError } = useToast()

  const [playlist, setPlaylist] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const data = await getPlaylist(id)
        if (!cancelled) {
          setPlaylist(data)
        }
      } catch {
        if (!cancelled) {
          setError('This playlist is unavailable right now.')
          toastError('Failed to load this playlist.')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [id, toastError])

  if (loading) {
    return null
  }

  if (error || !playlist) {
    return (
      <section className="playlist-page">
        <p className="playlist-page-status">{error ?? 'This playlist is unavailable right now.'}</p>
      </section>
    )
  }

  const ownerName = playlist.owner?.displayName || playlist.owner?.username
  const avatarUrl = playlist.owner?.username
    ? `${apiClient.defaults.baseURL}/api/v1/users/${playlist.owner.username}/avatar`
    : null

  // Same item PlaylistCard's thumbnail/title links to (position-ordered,
  // viewer-filtered - see getPlaylist).
  const firstVideoId = playlist.items[0]?.videoId ?? null

  function handlePlay() {
    if (!firstVideoId) {
      return
    }
    navigate(`/video?v=${firstVideoId}&list=${playlist.id}`)
  }

  return (
    <section className="playlist-page">
      <div className="playlist-page-info">
        <div className="playlist-page-info-main">
          <h1 className="playlist-page-title">{playlist.name}</h1>
          <div className="playlist-page-creator-row">
            <Link to={`/users/${playlist.owner?.username}`} className="playlist-page-avatar-link">
              {avatarUrl ? (
                <img className="playlist-page-avatar" src={avatarUrl} alt="" />
              ) : (
                <span className="playlist-page-avatar playlist-page-avatar-placeholder">
                  <UserRound size={20} />
                </span>
              )}
            </Link>
            <Link to={`/users/${playlist.owner?.username}`} className="playlist-page-creator">
              {ownerName}
            </Link>
          </div>
          {playlist.description && (
            <p className="playlist-page-description">{playlist.description}</p>
          )}
          <p className="playlist-page-stats">
            <span title={new Date(playlist.createdAt).toLocaleString()}>
              Created {formatRelativeDate(playlist.createdAt)}
            </span>{' '}
            &middot;{' '}
            <span className="playlist-page-visibility">{playlist.visibility}</span>{' '}
            &middot;{' '}
            {playlist.itemCount} {playlist.itemCount === 1 ? 'video' : 'videos'}{' '}
            &middot;{' '}
            <span title={new Date(playlist.updatedAt).toLocaleString()}>
              Updated {formatRelativeDate(playlist.updatedAt)}
            </span>
          </p>
        </div>
        <button
          type="button"
          className="playlist-page-play-btn"
          onClick={handlePlay}
          disabled={!firstVideoId}
        >
          <Play size={18} />
          Play
        </button>
      </div>

      {playlist.items.length > 0 ? (
        <div className="playlist-page-videos-grid">
          {playlist.items.map((video) => (
            <VideoCard
              key={video.id}
              video={video}
              linkTo={`/video?v=${video.videoId}&list=${playlist.id}`}
            />
          ))}
        </div>
      ) : (
        <p className="playlist-page-status">This playlist has no videos yet.</p>
      )}
    </section>
  )
}

export default PlaylistPage
