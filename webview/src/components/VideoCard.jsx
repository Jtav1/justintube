import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router-dom'
import { ImageOff, MoreVertical, VideoOff } from 'lucide-react'
import { formatDuration, formatRelativeDate, formatViewCount } from '../lib/format.js'
import { useAuth } from '../context/useAuth.js'
import { addVideoToPlaylist, listMyPlaylists } from '../api/playlists.js'
import apiClient from '../api/client.js'
import './VideoCard.css'

// Must match .video-card-title's font-size/font-weight in VideoCard.css.
const TITLE_FONT_SIZE = 18
const TITLE_FONT_WEIGHT = 500
const TITLE_SHRINK_PX = 4

function VideoCard({
  video,
  orientation = 'vertical',
  hideMenu = false,
  linkTo,
  active = false,
  onRemoveFromPlaylist,
}) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [dropdownPosition, setDropdownPosition] = useState(null)
  const menuRef = useRef(null)
  const toggleRef = useRef(null)
  const dropdownRef = useRef(null)
  const titleRef = useRef(null)
  const measureCanvasRef = useRef(null)
  const [titleShrunk, setTitleShrunk] = useState(false)

  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [myPlaylists, setMyPlaylists] = useState(null)
  const [playlistsLoading, setPlaylistsLoading] = useState(false)
  const [playlistsError, setPlaylistsError] = useState(null)
  const [addStatus, setAddStatus] = useState({})

  const canEdit = Boolean(user) && (user.role === 'admin' || video.uploader?.userId === user.id)

  useEffect(() => {
    const el = titleRef.current
    if (!el) {
      return undefined
    }

    function measure() {
      const canvas = measureCanvasRef.current ?? (measureCanvasRef.current = document.createElement('canvas'))
      const ctx = canvas.getContext('2d')
      const fontFamily = getComputedStyle(el).fontFamily
      ctx.font = `${TITLE_FONT_WEIGHT} ${TITLE_FONT_SIZE}px ${fontFamily}`
      const naturalWidth = ctx.measureText(video.title ?? '').width
      setTitleShrunk(naturalWidth > el.clientWidth)
    }

    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [video.title])

  const uploaderName = video.uploader?.displayName || video.uploader?.username
  const thumbnailUrl = video.thumbnailUrl
    ? `${apiClient.defaults.baseURL}${video.thumbnailUrl}`
    : null

  const isOwner = Boolean(user) && user.id === video.uploader?.userId
  const isModerator = user?.role === 'moderator' || user?.role === 'admin'
  const videoPath = linkTo ?? `/video?v=${video.videoId}`

  async function handleCopyLink() {
    setMenuOpen(false)
    await navigator.clipboard.writeText(`${window.location.origin}${videoPath}`)
  }

  function closeMenu() {
    setMenuOpen(false)
    setAddMenuOpen(false)
  }

  function handleToggleMenu() {
    if (!menuOpen) {
      const rect = toggleRef.current.getBoundingClientRect()
      const openUpward = window.innerHeight - rect.bottom < 220
      setDropdownPosition({
        right: window.innerWidth - rect.right,
        ...(openUpward
          ? { bottom: window.innerHeight - rect.top + 4 }
          : { top: rect.bottom + 4 }),
      })
      setMenuOpen(true)
    } else {
      closeMenu()
    }
  }

  async function handleToggleAddMenu() {
    const opening = !addMenuOpen
    setAddMenuOpen(opening)
    if (opening && myPlaylists === null && !playlistsLoading) {
      setPlaylistsLoading(true)
      setPlaylistsError(null)
      try {
        const data = await listMyPlaylists({ limit: 99 })
        setMyPlaylists(data.items)
      } catch {
        setPlaylistsError('Failed to load your playlists.')
      } finally {
        setPlaylistsLoading(false)
      }
    }
  }

  function handleCreateNewPlaylist() {
    closeMenu()
    navigate(`/playlists/new?videoId=${video.id}`)
  }

  async function handleAddToExistingPlaylist(playlistId) {
    setAddStatus((prev) => ({ ...prev, [playlistId]: 'adding' }))
    try {
      await addVideoToPlaylist(playlistId, video.id)
      closeMenu()
    } catch (err) {
      const conflict = err?.response?.status === 409
      setAddStatus((prev) => ({ ...prev, [playlistId]: conflict ? 'conflict' : 'error' }))
    }
  }

  useEffect(() => {
    if (!menuOpen) {
      return undefined
    }

    function handleClickOutside(event) {
      const clickedMenu = menuRef.current?.contains(event.target)
      const clickedDropdown = dropdownRef.current?.contains(event.target)
      if (!clickedMenu && !clickedDropdown) {
        closeMenu()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [menuOpen])

  useEffect(() => {
    if (!menuOpen) {
      return undefined
    }

    // The dropdown is portaled to <body> with a fixed position computed on
    // open, so it won't track its trigger if an ancestor (e.g. the playlist
    // queue's scrollable rail) scrolls - close it instead of leaving it
    // floating in the wrong place.
    function handleScroll() {
      closeMenu()
    }

    window.addEventListener('scroll', handleScroll, true)
    return () => window.removeEventListener('scroll', handleScroll, true)
  }, [menuOpen])

  return (
    <article
      className={`video-card video-card-${orientation}${menuOpen ? ' video-card-menu-open' : ''}${active ? ' video-card-active' : ''}`}
    >
      <Link to={videoPath} className="video-card-thumb">
        {thumbnailUrl ? (
          <img src={thumbnailUrl} alt="" loading="lazy" />
        ) : (
          <div className="video-card-thumb-placeholder">
            {video.mediaType === 'audio' ? <VideoOff size={28} /> : <ImageOff size={28} />}
          </div>
        )}
        {video.durationSeconds != null && (
          <span className="video-card-duration">{formatDuration(video.durationSeconds)}</span>
        )}
      </Link>
      <div className="video-card-body">
        <div className="video-card-text">
          <h3
            className="video-card-title"
            ref={titleRef}
            style={titleShrunk ? { fontSize: TITLE_FONT_SIZE - TITLE_SHRINK_PX } : undefined}
          >
            <Link to={videoPath}>{video.title}</Link>
          </h3>
          <p className="video-card-meta">
            <Link to={`/users/${video.uploader?.username}`}>{uploaderName}</Link>
          </p>
          <p className="video-card-meta">
            {formatViewCount(video.viewCount)} &middot; {formatRelativeDate(video.createdAt)}
          </p>
        </div>
        {!hideMenu && (
          <div className="video-card-menu" ref={menuRef}>
            <button
              ref={toggleRef}
              type="button"
              className="video-card-menu-toggle"
              aria-label="Video options"
              onClick={handleToggleMenu}
            >
              <MoreVertical size={18} />
            </button>
            {menuOpen && dropdownPosition && createPortal(
              <div
                className="video-card-menu-dropdown"
                ref={dropdownRef}
                style={{ position: 'fixed', ...dropdownPosition }}
              >
                <button type="button" className="video-card-menu-item" onClick={handleCopyLink}>
                  Copy Link
                </button>
                <button type="button" className="video-card-menu-item" onClick={handleToggleAddMenu}>
                  Add to Playlist
                </button>
                {addMenuOpen && (
                  <div className="video-card-playlist-submenu">
                    <button
                      type="button"
                      className="video-card-playlist-submenu-item video-card-playlist-submenu-create"
                      onClick={handleCreateNewPlaylist}
                    >
                      Create New Playlist
                    </button>
                    {playlistsLoading && (
                      <p className="video-card-playlist-submenu-note">Loading your playlists...</p>
                    )}
                    {playlistsError && (
                      <p className="video-card-playlist-submenu-note video-card-playlist-submenu-error">
                        {playlistsError}
                      </p>
                    )}
                    {!playlistsLoading && myPlaylists && myPlaylists.length === 0 && (
                      <p className="video-card-playlist-submenu-note">
                        You don&apos;t have any playlists yet.
                      </p>
                    )}
                    {myPlaylists?.map((playlist) => {
                      const status = addStatus[playlist.id]
                      return (
                        <button
                          key={playlist.id}
                          type="button"
                          className="video-card-playlist-submenu-item"
                          disabled={status === 'adding'}
                          onClick={() => handleAddToExistingPlaylist(playlist.id)}
                        >
                          {playlist.title}
                          {status === 'adding' && ' — Adding...'}
                          {status === 'conflict' && ' — Already added'}
                          {status === 'error' && ' — Failed, try again'}
                        </button>
                      )
                    })}
                  </div>
                )}
                {onRemoveFromPlaylist && (
                  <button
                    type="button"
                    className="video-card-menu-item"
                    onClick={() => {
                      closeMenu()
                      onRemoveFromPlaylist()
                    }}
                  >
                    Remove from Playlist
                  </button>
                )}
                {canEdit && (
                  <Link
                    to={`/upload?v=${video.videoId}`}
                    className="video-card-menu-item"
                    onClick={closeMenu}
                  >
                    Edit
                  </Link>
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
              </div>,
              document.body,
            )}
          </div>
        )}
      </div>
    </article>
  )
}

export default VideoCard
