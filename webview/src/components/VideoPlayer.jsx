import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Pencil, Repeat, Settings2, ThumbsDown, ThumbsUp, UserRound } from 'lucide-react'
import { formatViewCount } from '../lib/format.js'
import apiClient from '../api/client.js'
import { dislikeVideo, likeVideo, recordView } from '../api/videos.js'
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

function VideoPlayer({ video }) {
  const { user } = useAuth()
  const renditions = video.renditions ?? []
  const [selectedRendition, setSelectedRendition] = useState(() => pickDefaultRendition(renditions))
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false)
  const [loop, setLoop] = useState(false)
  const [reaction, setReaction] = useState(video.viewerReaction ?? null)
  const [reactionPending, setReactionPending] = useState(false)
  const [avatarFailed, setAvatarFailed] = useState(false)

  const videoRef = useRef(null)
  const qualityMenuRef = useRef(null)
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

  return (
    <div className="video-player">
      <div className="video-player-frame">
        <video
          ref={videoRef}
          key={memoizedSrc}
          src={memoizedSrc}
          controls
          loop={loop}
          onLoadedMetadata={handleLoadedMetadata}
          onPlay={handleFirstPlay}
        />
        <div className="video-player-controls-overlay">
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
                  <span key={tag} className="video-player-tag">
                    {tag}
                  </span>
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
