import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  EyeOff,
  Link as LinkIcon,
  ListMinus,
  ListPlus,
  Pencil,
  Repeat,
  Settings2,
  ThumbsDown,
  ThumbsUp,
  UserRound,
  VideoOff,
} from 'lucide-react'
import { formatViewCount } from '../lib/format.js'
import apiClient from '../api/client.js'
import { delistVideo, dislikeVideo, likeVideo, recordView } from '../api/videos.js'
import { addVideoToPlaylist, listMyPlaylists } from '../api/playlists.js'
import { useAuth } from '../context/useAuth.js'
import './VideoPlayer.css'

// Must match .video-player-title's font-size/font-weight in VideoPlayer.css.
const TITLE_FONT_SIZE = 20
const TITLE_FONT_WEIGHT = 600
const TITLE_SHRINK_PX = 4

/**
 * Picks the default rendition to play: the highest non-"original" resolution
 * when transcodes exist, otherwise falls back to "original".
 *
 * @param {Array<{resolution: string, height: number|null}>} renditions Available renditions.
 * @returns {object|undefined} The rendition to select by default.
 */
function pickDefaultRendition(renditions) {
  const transcoded = renditions.filter((r) => r.resolution !== 'original')
  if (transcoded.length === 0) {
    return renditions.find((r) => r.resolution === 'original') ?? renditions[0]
  }
  return transcoded.reduce((best, current) =>
    (current.height ?? 0) > (best.height ?? 0) ? current : best,
  )
}

function VideoPlayer({ video, onRemoveFromPlaylist }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const renditions = video.renditions ?? []
  const isAudio = video.mediaType === 'audio'
  const [selectedRendition, setSelectedRendition] = useState(() => pickDefaultRendition(renditions))
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false)
  const [loop, setLoop] = useState(false)
  const [reaction, setReaction] = useState(video.viewerReaction ?? null)
  const [reactionPending, setReactionPending] = useState(false)
  const [avatarFailed, setAvatarFailed] = useState(false)
  const [delisted, setDelisted] = useState(false)
  const [delistPending, setDelistPending] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)

  const [playlistMenuOpen, setPlaylistMenuOpen] = useState(false)
  const [myPlaylists, setMyPlaylists] = useState(null)
  const [playlistsLoading, setPlaylistsLoading] = useState(false)
  const [playlistsError, setPlaylistsError] = useState(null)
  const [addStatus, setAddStatus] = useState({})

  const videoRef = useRef(null)
  const qualityMenuRef = useRef(null)
  const playlistMenuRef = useRef(null)
  const playlistDropdownRef = useRef(null)
  const resumeStateRef = useRef(null)
  const viewRecordedRef = useRef(false)
  const titleRef = useRef(null)
  const measureCanvasRef = useRef(null)
  const [titleShrunk, setTitleShrunk] = useState(false)

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

  const streamUrl = selectedRendition
    ? `${apiClient.defaults.baseURL}${selectedRendition.streamUrl}`
    : null

  const canEdit = Boolean(user) && (user.role === 'admin' || video.uploader?.userId === user.id)
  const isModerator = Boolean(user) && (user.role === 'moderator' || user.role === 'admin')

  const uploaderName = video.uploader?.displayName || video.uploader?.username
  const avatarUrl = video.uploader?.username
    ? `${apiClient.defaults.baseURL}/api/v1/users/${video.uploader.username}/avatar`
    : null

  useEffect(() => {
    viewRecordedRef.current = false
  }, [video.id])

  useEffect(() => {
    if (!qualityMenuOpen) {
      return undefined
    }

    function handleClickOutside(event) {
      if (qualityMenuRef.current && !qualityMenuRef.current.contains(event.target)) {
        setQualityMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [qualityMenuOpen])

  useEffect(() => {
    if (!playlistMenuOpen) {
      return undefined
    }

    function handleClickOutside(event) {
      if (playlistMenuRef.current && !playlistMenuRef.current.contains(event.target)) {
        setPlaylistMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [playlistMenuOpen])

  useEffect(() => {
    if (playlistMenuOpen) {
      playlistDropdownRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [playlistMenuOpen])

  async function handleTogglePlaylistMenu() {
    const opening = !playlistMenuOpen
    setPlaylistMenuOpen(opening)
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
    setPlaylistMenuOpen(false)
    navigate(`/playlists/new?videoId=${video.id}`)
  }

  async function handleAddToExistingPlaylist(playlistId) {
    setAddStatus((prev) => ({ ...prev, [playlistId]: 'adding' }))
    try {
      await addVideoToPlaylist(playlistId, video.id)
      setPlaylistMenuOpen(false)
    } catch (err) {
      const conflict = err?.response?.status === 409
      setAddStatus((prev) => ({ ...prev, [playlistId]: conflict ? 'conflict' : 'error' }))
    }
  }

  function handleSelectQuality(rendition) {
    const el = videoRef.current
    if (el) {
      resumeStateRef.current = { currentTime: el.currentTime, wasPlaying: !el.paused }
    }
    setSelectedRendition(rendition)
    setQualityMenuOpen(false)
  }

  function handleLoadedMetadata() {
    const el = videoRef.current
    const resume = resumeStateRef.current
    if (!el || !resume) {
      return
    }
    el.currentTime = resume.currentTime
    if (resume.wasPlaying) {
      el.play()
    }
    resumeStateRef.current = null
  }

  const memoizedSrc = useMemo(() => streamUrl, [streamUrl])

  function handleFirstPlay() {
    if (viewRecordedRef.current) {
      return
    }
    viewRecordedRef.current = true
    recordView(video.id).catch((err) => console.error('Failed to record view:', err))
  }

  async function handleLike() {
    if (!user || reactionPending) {
      return
    }
    setReactionPending(true)
    try {
      const result = await likeVideo(video.id)
      setReaction(result.liked ? 'like' : result.disliked ? 'dislike' : null)
    } catch (err) {
      console.error('Failed to like video:', err)
    } finally {
      setReactionPending(false)
    }
  }

  async function handleDislike() {
    if (!user || reactionPending) {
      return
    }
    setReactionPending(true)
    try {
      const result = await dislikeVideo(video.id)
      setReaction(result.liked ? 'like' : result.disliked ? 'dislike' : null)
    } catch (err) {
      console.error('Failed to dislike video:', err)
    } finally {
      setReactionPending(false)
    }
  }

  async function handleDelist() {
    if (delistPending || delisted) {
      return
    }
    setDelistPending(true)
    try {
      await delistVideo(video.id)
      setDelisted(true)
    } catch (err) {
      console.error('Failed to delist video:', err)
    } finally {
      setDelistPending(false)
    }
  }

  async function handleCopyLink() {
    await navigator.clipboard.writeText(`${window.location.origin}/video?v=${video.videoId}`)
    setLinkCopied(true)
    setTimeout(() => setLinkCopied(false), 1500)
  }

  return (
    <div className="video-player">
      <div className={`video-player-frame${isAudio ? ' video-player-frame-audio' : ''}`}>
        {isAudio ? (
          <div className="video-player-audio-frame">
            <VideoOff size={64} className="video-player-audio-icon" />
            <audio
              ref={videoRef}
              key={memoizedSrc}
              src={memoizedSrc}
              controls
              loop={loop}
              className="video-player-audio-element"
              onLoadedMetadata={handleLoadedMetadata}
              onPlay={handleFirstPlay}
            />
          </div>
        ) : (
          <video
            ref={videoRef}
            key={memoizedSrc}
            src={memoizedSrc}
            controls
            loop={loop}
            onLoadedMetadata={handleLoadedMetadata}
            onPlay={handleFirstPlay}
          />
        )}
        <div className="video-player-controls-overlay">
          {renditions.length > 0 && (
            <div className="video-player-quality" ref={qualityMenuRef}>
              <button
                type="button"
                className={`video-player-icon-btn${qualityMenuOpen ? ' video-player-icon-btn-active' : ''}`}
                aria-label="Select video quality"
                onClick={() => setQualityMenuOpen((prev) => !prev)}
              >
                <Settings2 size={18} />
              </button>
              {qualityMenuOpen && (
                <div className="video-player-quality-dropdown">
                  {renditions.map((rendition) => (
                    <button
                      key={rendition.streamUrl}
                      type="button"
                      className={`video-player-quality-item${
                        rendition === selectedRendition ? ' video-player-quality-item-active' : ''
                      }`}
                      onClick={() => handleSelectQuality(rendition)}
                    >
                      {rendition.resolution}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            className={`video-player-icon-btn${loop ? ' video-player-icon-btn-active' : ''}`}
            aria-label={loop ? 'Disable loop' : 'Enable loop'}
            aria-pressed={loop}
            onClick={() => setLoop((prev) => !prev)}
          >
            <Repeat size={18} />
          </button>
        </div>
      </div>

      <div className="video-player-meta">
        <div className="video-player-meta-main">
          <Link to={`/users/${video.uploader?.username}`} className="video-player-avatar-link">
            {avatarUrl && !avatarFailed ? (
              <img
                className="video-player-avatar"
                src={avatarUrl}
                alt=""
                onError={() => setAvatarFailed(true)}
              />
            ) : (
              <span className="video-player-avatar video-player-avatar-placeholder">
                <UserRound size={24} />
              </span>
            )}
          </Link>
          <div className="video-player-text">
            <h1
              className="video-player-title"
              ref={titleRef}
              style={titleShrunk ? { fontSize: TITLE_FONT_SIZE - TITLE_SHRINK_PX } : undefined}
            >
              {video.title}
            </h1>
            <p className="video-player-uploader">
              <Link to={`/users/${video.uploader?.username}`}>{uploaderName}</Link>
            </p>
            <p className="video-player-stats">
              {formatViewCount(video.viewCount)} &middot;{' '}
              <span className="video-player-visibility">{video.visibility}</span>
            </p>
            {video.description && (
              <p className="video-player-description">{video.description}</p>
            )}
            {video.tags?.length > 0 && (
              <div className="video-player-tags">
                <span className="video-player-tags-label">Tags: </span>
                {video.tags.map((tag) => (
                  <Link
                    key={tag}
                    to={`/search?q=${encodeURIComponent(tag)}`}
                    className="video-player-tag"
                  >
                    {tag}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="video-player-reactions">
          {canEdit && (
            <Link
              to={`/upload?v=${video.videoId}`}
              className="video-player-icon-btn"
              aria-label="Edit video"
            >
              <Pencil size={18} />
            </Link>
          )}
          {isModerator && (
            <button
              type="button"
              className="video-player-icon-btn"
              aria-label={delisted ? 'Video delisted' : 'Delist video'}
              disabled={delistPending || delisted}
              onClick={handleDelist}
            >
              <EyeOff size={18} />
            </button>
          )}
          <button
            type="button"
            className="video-player-icon-btn"
            aria-label={linkCopied ? 'Link copied' : 'Copy video link'}
            onClick={handleCopyLink}
          >
            <LinkIcon size={18} />
          </button>
          <div className="video-player-add-to-playlist" ref={playlistMenuRef}>
            <button
              type="button"
              className={`video-player-icon-btn${playlistMenuOpen ? ' video-player-icon-btn-active' : ''}`}
              aria-label="Add to playlist"
              disabled={!user}
              onClick={handleTogglePlaylistMenu}
            >
              <ListPlus size={18} />
            </button>
            {playlistMenuOpen && (
              <div className="video-player-playlist-dropdown" ref={playlistDropdownRef}>
                <button
                  type="button"
                  className="video-player-playlist-item video-player-playlist-item-create"
                  onClick={handleCreateNewPlaylist}
                >
                  Create New Playlist
                </button>
                {playlistsLoading && (
                  <p className="video-player-playlist-note">Loading your playlists...</p>
                )}
                {playlistsError && (
                  <p className="video-player-playlist-note video-player-playlist-note-error">
                    {playlistsError}
                  </p>
                )}
                {!playlistsLoading && myPlaylists && myPlaylists.length === 0 && (
                  <p className="video-player-playlist-note">
                    You don&apos;t have any playlists yet.
                  </p>
                )}
                {myPlaylists?.map((playlist) => {
                  const status = addStatus[playlist.id]
                  return (
                    <button
                      key={playlist.id}
                      type="button"
                      className="video-player-playlist-item"
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
          </div>
          {onRemoveFromPlaylist && (
            <button
              type="button"
              className="video-player-icon-btn"
              aria-label="Remove from playlist"
              onClick={onRemoveFromPlaylist}
            >
              <ListMinus size={18} />
            </button>
          )}
          <button
            type="button"
            className={`video-player-icon-btn${reaction === 'like' ? ' video-player-icon-btn-like-active' : ''}`}
            aria-label="Like"
            aria-pressed={reaction === 'like'}
            disabled={!user || reactionPending}
            onClick={handleLike}
          >
            <ThumbsUp size={18} />
          </button>
          <button
            type="button"
            className={`video-player-icon-btn${reaction === 'dislike' ? ' video-player-icon-btn-dislike-active' : ''}`}
            aria-label="Dislike"
            aria-pressed={reaction === 'dislike'}
            disabled={!user || reactionPending}
            onClick={handleDislike}
          >
            <ThumbsDown size={18} />
          </button>
        </div>
      </div>
    </div>
  )
}

export default VideoPlayer
