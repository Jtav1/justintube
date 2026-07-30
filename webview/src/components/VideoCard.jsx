import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ImageOff, MoreVertical } from 'lucide-react'
import { formatDuration, formatRelativeDate, formatViewCount } from '../lib/format.js'
import { useAuth } from '../context/useAuth.js'
import apiClient from '../api/client.js'
import './VideoCard.css'

function VideoCard({ video, orientation = 'vertical' }) {
  const { user } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)

  const uploaderName = video.uploader?.displayName || video.uploader?.username
  const thumbnailUrl = video.thumbnailUrl
    ? `${apiClient.defaults.baseURL}${video.thumbnailUrl}`
    : null

  const isOwner = Boolean(user) && user.id === video.uploader?.userId
  const isModerator = user?.role === 'moderator' || user?.role === 'admin'
  const videoPath = `/video?v=${video.videoId}`

  async function handleCopyLink() {
    setMenuOpen(false)
    await navigator.clipboard.writeText(`${window.location.origin}${videoPath}`)
  }

  useEffect(() => {
    if (!menuOpen) {
      return undefined
    }

    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [menuOpen])

  return (
    <article
      className={`video-card video-card-${orientation}${menuOpen ? ' video-card-menu-open' : ''}`}
    >
      <Link to={videoPath} className="video-card-thumb">
        {thumbnailUrl ? (
          <img src={thumbnailUrl} alt="" loading="lazy" />
        ) : (
          <div className="video-card-thumb-placeholder">
            <ImageOff size={28} />
          </div>
        )}
        {video.durationSeconds != null && (
          <span className="video-card-duration">{formatDuration(video.durationSeconds)}</span>
        )}
      </Link>
      <div className="video-card-body">
        <div className="video-card-text">
          <h3 className="video-card-title">
            <Link to={videoPath}>{video.title}</Link>
          </h3>
          <p className="video-card-meta">{uploaderName}</p>
          <p className="video-card-meta">
            {formatViewCount(video.viewCount)} &middot; {formatRelativeDate(video.createdAt)}
          </p>
        </div>
        <div className="video-card-menu" ref={menuRef}>
          <button
            type="button"
            className="video-card-menu-toggle"
            aria-label="Video options"
            onClick={() => setMenuOpen((prev) => !prev)}
          >
            <MoreVertical size={18} />
          </button>
          {menuOpen && (
            <div className="video-card-menu-dropdown">
              <button type="button" className="video-card-menu-item" onClick={handleCopyLink}>
                Copy Link
              </button>
              <button type="button" className="video-card-menu-item" onClick={() => setMenuOpen(false)}>
                Add to Playlist
              </button>
              {isOwner && (
                <button
                  type="button"
                  className="video-card-menu-item"
                  onClick={() => setMenuOpen(false)}
                >
                  Edit
                </button>
              )}
              {isModerator && (
                <button
                  type="button"
                  className="video-card-menu-item"
                  onClick={() => setMenuOpen(false)}
                >
                  MOD: Delist
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  )
}

export default VideoCard
