import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Repeat, Settings2, ThumbsDown, ThumbsUp, UserRound } from 'lucide-react'
import { formatViewCount } from '../lib/format.js'
import apiClient from '../api/client.js'
import './VideoPlayer.css'

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
  const renditions = video.renditions ?? []
  const [selectedRendition, setSelectedRendition] = useState(() => pickDefaultRendition(renditions))
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false)
  const [loop, setLoop] = useState(false)
  const [reaction, setReaction] = useState(null)
  const [avatarFailed, setAvatarFailed] = useState(false)

  const videoRef = useRef(null)
  const qualityMenuRef = useRef(null)
  const resumeStateRef = useRef(null)

  const streamUrl = selectedRendition
    ? `${apiClient.defaults.baseURL}${selectedRendition.streamUrl}`
    : null

  const uploaderName = video.uploader?.displayName || video.uploader?.username
  const avatarUrl = video.uploader?.username
    ? `${apiClient.defaults.baseURL}/api/v1/users/${video.uploader.username}/avatar`
    : null

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
            <h1 className="video-player-title">{video.title}</h1>
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
          </div>
        </div>

        <div className="video-player-reactions">
          <button
            type="button"
            className={`video-player-icon-btn${reaction === 'like' ? ' video-player-icon-btn-active' : ''}`}
            aria-label="Like"
            aria-pressed={reaction === 'like'}
            onClick={() => setReaction((prev) => (prev === 'like' ? null : 'like'))}
          >
            <ThumbsUp size={18} />
          </button>
          <button
            type="button"
            className={`video-player-icon-btn${reaction === 'dislike' ? ' video-player-icon-btn-active' : ''}`}
            aria-label="Dislike"
            aria-pressed={reaction === 'dislike'}
            onClick={() => setReaction((prev) => (prev === 'dislike' ? null : 'dislike'))}
          >
            <ThumbsDown size={18} />
          </button>
        </div>
      </div>
    </div>
  )
}

export default VideoPlayer
