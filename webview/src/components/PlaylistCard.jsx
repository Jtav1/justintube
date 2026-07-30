import { useEffect, useRef, useState } from 'react'
import { ImageOff, MoreVertical } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/useAuth.js'
import apiClient from '../api/client.js'
import './PlaylistCard.css'

function PlaylistCard({ playlist }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)
  const dropdownRef = useRef(null)

  const thumbnails = (playlist.thumbnails ?? []).slice(0, 3)
  const ownerName = playlist.owner?.displayName || playlist.owner?.username
  const hasLink = Boolean(playlist.latestVideoId)
  const linkProps = hasLink
    ? { to: `/video?v=${playlist.latestVideoId}&list=${playlist.id}` }
    : {}
  const ThumbTag = hasLink ? Link : 'div'
  const TitleTag = hasLink ? Link : 'span'

  const canEdit = Boolean(user)
    && (String(user.id) === String(playlist.owner?.id) || user.role === 'admin')

  function closeMenu() {
    setMenuOpen(false)
  }

  function handleEditPlaylist() {
    closeMenu()
    navigate(`/playlists/${playlist.id}/edit`)
  }

  useEffect(() => {
    if (!menuOpen) {
      return undefined
    }

    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        closeMenu()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [menuOpen])

  useEffect(() => {
    if (menuOpen) {
      dropdownRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [menuOpen])

  return (
    <article className={`playlist-card${menuOpen ? ' playlist-card-menu-open' : ''}`}>
      <ThumbTag className="playlist-card-thumb" {...linkProps}>
        {thumbnails.length > 0 ? (
          thumbnails.map((url, i) => (
            <img
              key={url}
              src={`${apiClient.defaults.baseURL}${url}`}
              alt=""
              loading="lazy"
              className={`playlist-card-thumb-layer playlist-card-thumb-layer-${i}`}
            />
          ))
        ) : (
          <div className="playlist-card-thumb-placeholder">
            <ImageOff size={28} />
          </div>
        )}
        <span className="playlist-card-count-badge">{playlist.itemCount}</span>
      </ThumbTag>
      <div className="playlist-card-body">
        <div className="playlist-card-text">
          <h3 className="playlist-card-title">
            <TitleTag {...linkProps}>{playlist.name}</TitleTag>
          </h3>
          {ownerName && <p className="playlist-card-meta">{ownerName}</p>}
          <p className="playlist-card-meta">
            {playlist.itemCount} {playlist.itemCount === 1 ? 'video' : 'videos'}
          </p>
        </div>
        {canEdit && (
          <div className="playlist-card-menu" ref={menuRef}>
            <button
              type="button"
              className="playlist-card-menu-toggle"
              aria-label="Playlist options"
              onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
            >
              <MoreVertical size={18} />
            </button>
            {menuOpen && (
              <div className="playlist-card-menu-dropdown" ref={dropdownRef}>
                <button type="button" className="playlist-card-menu-item" onClick={handleEditPlaylist}>
                  Edit Playlist
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  )
}

export default PlaylistCard
