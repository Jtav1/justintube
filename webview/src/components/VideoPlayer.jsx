import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  EyeOff,
  EyeClosed,
  Link as LinkIcon,
  ListMinus,
  ListPlus,
  TriangleAlert,
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
import {
  addVideoTags,
  removeVideoTags,
  delistVideo,
  dislikeVideo,
  likeVideo,
  recordView,
  hideVideo,
} from '../api/videos.js'
import { addVideoToPlaylist, listMyPlaylists } from '../api/playlists.js'
import { getSubscriptionState, subscribeToUser, unsubscribeFromUser } from '../api/users.js'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import { useDismissablePopover } from '../hooks/useDismissablePopover.js'
import ChipInput from './ChipInput.jsx'
import ReactionScore from './ReactionScore.jsx'
import './VideoPlayer.css'

// Must match .video-player-title's font-size/font-weight in VideoPlayer.css.
const TITLE_FONT_SIZE = 24
const TITLE_FONT_WEIGHT = 600
const TITLE_SHRINK_PX = 4

// Mirrors webapi's MAX_TAGS/MAX_TAG_LENGTH (webapi/routes/videos.js).
const MAX_TAG_LENGTH = 255
const MAX_TAGS = 50

// MEDIA_ERR_NETWORK/MEDIA_ERR_SRC_NOT_SUPPORTED can fire for transient causes
// (a seek landing ahead of what the server has buffered/flushed, or a fetch
// aborted by a quality-switch remount) rather than an actually corrupt file.
// Retry with backoff before surfacing an error to the user.
const TRANSIENT_MEDIA_ERROR_CODES = new Set([
  MediaError.MEDIA_ERR_NETWORK,
  MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED,
])
const RETRY_BACKOFF_MS = [500, 1500, 3000]

// How long the "Next video Autoplaying" countdown overlay counts down from
// when the video ends and autoplay is on (see the Autoplay toggle in
// VideoSuggested).
const AUTOPLAY_COUNTDOWN_SECONDS = 5

// How long to wait, on a page load reached via the autoplay countdown
// (`?autoplay=1`, see autoplayOnLoad), before starting playback.
const AUTOPLAY_ON_LOAD_DELAY_MS = 2000

/**
 * Picks the default rendition to play: always "original" when available,
 * otherwise falls back to whatever rendition is first.
 *
 * @param {Array<{resolution: string, height: number|null}>} renditions Available renditions.
 * @returns {object|undefined} The rendition to select by default.
 */
function pickDefaultRendition(renditions) {
  return renditions.find((r) => r.resolution === 'original') ?? renditions[0]
}

function VideoPlayer({
  video,
  onRemoveFromPlaylist,
  onReport,
  autoplayEnabled = false,
  onAutoplayNext,
  onAutoplayChange,
  autoplayOnLoad = false,
}) {
  const { user } = useAuth()
  const { error: toastError } = useToast()
  const navigate = useNavigate()
  const renditions = video.renditions ?? []
  const isAudio = video.mediaType === 'audio'
  const [selectedRendition, setSelectedRendition] = useState(() => pickDefaultRendition(renditions))
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false)
  const [loop, setLoop] = useState(false)
  const [reaction, setReaction] = useState(video.viewerReaction ?? null)
  const [reactionPending, setReactionPending] = useState(false)
  const [reactionDelta, setReactionDelta] = useState({ likeCount: 0, dislikeCount: 0 })
  const [reactionDeltaVideoId, setReactionDeltaVideoId] = useState(video.id)
  if (video.id !== reactionDeltaVideoId) {
    setReactionDeltaVideoId(video.id)
    setReactionDelta({ likeCount: 0, dislikeCount: 0 })
  }
  const [displayedTags, setDisplayedTags] = useState(video.tags ?? [])
  const [displayedTagsVideoId, setDisplayedTagsVideoId] = useState(video.id)
  if (video.id !== displayedTagsVideoId) {
    setDisplayedTagsVideoId(video.id)
    setDisplayedTags(video.tags ?? [])
  }
  const [tagEditMode, setTagEditMode] = useState(false)
  const [tagInput, setTagInput] = useState('')
  const [pendingAddTags, setPendingAddTags] = useState([])
  const [pendingRemoveTags, setPendingRemoveTags] = useState([])
  const [tagSaving, setTagSaving] = useState(false)
  const [tagError, setTagError] = useState(false)
  const [avatarFailed, setAvatarFailed] = useState(false)
  const [delisted, setDelisted] = useState(false)
  const [delistPending, setDelistPending] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  const [subscribed, setSubscribed] = useState(null)
  const [subscribePending, setSubscribePending] = useState(false)
  const [hideError, setHideError] = useState(false)
  const [playbackError, setPlaybackError] = useState(false)
  // Seconds remaining in the "Next video Autoplaying" overlay countdown;
  // null means the overlay isn't showing.
  const [autoplayCountdown, setAutoplayCountdown] = useState(null)
  const [autoplayCountdownVideoId, setAutoplayCountdownVideoId] = useState(video.id)
  if (video.id !== autoplayCountdownVideoId) {
    setAutoplayCountdownVideoId(video.id)
    setAutoplayCountdown(null)
  }
  // Autoplay turned off mid-countdown (Cancel button below, or the toggle in
  // VideoSuggested) - drop the overlay so the ticking effect's cleanup runs
  // and the scheduled navigation never fires.
  const [countdownAutoplayEnabled, setCountdownAutoplayEnabled] = useState(autoplayEnabled)
  if (autoplayEnabled !== countdownAutoplayEnabled) {
    setCountdownAutoplayEnabled(autoplayEnabled)
    if (!autoplayEnabled) {
      setAutoplayCountdown(null)
    }
  }

  const [playlistMenuOpen, setPlaylistMenuOpen] = useState(false)
  const [myPlaylists, setMyPlaylists] = useState(null)
  const [playlistsLoading, setPlaylistsLoading] = useState(false)
  const [playlistsError, setPlaylistsError] = useState(null)
  const [addStatus, setAddStatus] = useState({})

  const videoRef = useRef(null)
  const qualityMenuRef = useRef(null)
  const qualityToggleRef = useRef(null)
  const playlistMenuRef = useRef(null)
  const playlistToggleRef = useRef(null)
  const playlistDropdownRef = useRef(null)
  const resumeStateRef = useRef(null)
  const retryCountRef = useRef(0)
  const retryTimeoutRef = useRef(null)
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

  const canEdit =
    video.viewerPermission === 'owner' || video.viewerPermission === 'edit'
  const isModerator = Boolean(user) && (user.role === 'moderator' || user.role === 'admin')
  // "Trusted User": verified email + uploader access, admins bypass. Anyone who
  // can view this video (they're on this page) and is a Trusted User may add
  // tags to it - see POST /videos/:id/tags (addVideoTags).
  const canAddTags = Boolean(user) && (user.role === 'admin' || (user.uploader && user.emailVerified))
  // Removing a tag (including one another Trusted User added) is a
  // moderation-level action - see DELETE /videos/:id/tags (removeVideoTags).
  const canRemoveTags = video.viewerPermission === 'owner' || isModerator
  const canEditTags = canAddTags || canRemoveTags

  const uploaderName = video.uploader?.displayName || video.uploader?.username
  const avatarUrl = video.uploader?.username
    ? `${apiClient.defaults.baseURL}/api/v1/users/${video.uploader.username}/avatar`
    : null

  const uploaderId = video.uploader?.userId ?? null
  const canSubscribe = Boolean(user) && uploaderId != null && user.id !== uploaderId

  useEffect(() => {
    viewRecordedRef.current = false
  }, [video.id])

  // Arrived via the autoplay countdown (?autoplay=1) - wait a beat, then
  // start playback ourselves rather than requiring a click.
  useEffect(() => {
    if (!autoplayOnLoad) {
      return undefined
    }
    const timeout = setTimeout(() => {
      videoRef.current?.play().catch(() => {})
    }, AUTOPLAY_ON_LOAD_DELAY_MS)
    return () => clearTimeout(timeout)
  }, [autoplayOnLoad])

  useEffect(() => {
    let cancelled = false
    setSubscribed(null)

    if (!canSubscribe) {
      return undefined
    }

    getSubscriptionState(uploaderId)
      .then((data) => {
        if (!cancelled) {
          setSubscribed(data.subscribed)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSubscribed(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [canSubscribe, uploaderId])

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

  useDismissablePopover(qualityMenuOpen, () => setQualityMenuOpen(false), qualityToggleRef)

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

  useDismissablePopover(playlistMenuOpen, () => setPlaylistMenuOpen(false), playlistToggleRef)

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

  async function handleHide() {
    if (!window.confirm('Hide this video forever? You won\'t see it recommended again.')) {
      return
    }
    setHideError(false)
    try {
      await hideVideo(video.id)
      window.location.reload()
    } catch {
      setHideError(true)
      toastError('Hiding video failed.')
    }
  }

  function addPendingTagFromInput(rawText) {
    const parts = rawText
      .split(',')
      .map((part) => part.trim().slice(0, MAX_TAG_LENGTH))
      .filter(Boolean)
    if (parts.length === 0) {
      return
    }
    const keptLower = new Set(
      displayedTags.filter((tag) => !pendingRemoveTags.includes(tag)).map((tag) => tag.toLowerCase()),
    )
    setPendingAddTags((prev) => {
      const prevLower = new Set(prev.map((tag) => tag.toLowerCase()))
      const additions = parts.filter(
        (part) => !keptLower.has(part.toLowerCase()) && !prevLower.has(part.toLowerCase()),
      )
      return [...prev, ...additions].slice(0, MAX_TAGS)
    })
    setTagInput('')
  }

  // A chip in the editor is either an existing tag (mark for removal) or one
  // typed this session that hasn't been saved yet (just drop it).
  function removeEditorTag(tag) {
    if (pendingAddTags.includes(tag)) {
      setPendingAddTags((prev) => prev.filter((t) => t !== tag))
    } else {
      setPendingRemoveTags((prev) => [...prev, tag])
    }
  }

  function handleCancelTagEdit() {
    setTagEditMode(false)
    setPendingAddTags([])
    setPendingRemoveTags([])
    setTagInput('')
    setTagError(false)
  }

  async function handleSaveTags() {
    if (pendingAddTags.length === 0 && pendingRemoveTags.length === 0) {
      setTagEditMode(false)
      return
    }
    setTagSaving(true)
    setTagError(false)
    try {
      let nextTags = displayedTags
      if (pendingAddTags.length > 0) {
        const addResult = await addVideoTags(video.id, pendingAddTags)
        nextTags = addResult.tags ?? [...nextTags, ...pendingAddTags]
      }
      if (pendingRemoveTags.length > 0) {
        const removeResult = await removeVideoTags(video.id, pendingRemoveTags)
        nextTags = removeResult.tags ?? nextTags.filter((tag) => !pendingRemoveTags.includes(tag))
      }
      setDisplayedTags(nextTags)
      setPendingAddTags([])
      setPendingRemoveTags([])
      setTagInput('')
      setTagEditMode(false)
    } catch (err) {
      console.error('Failed to save tag changes:', err)
      setTagError(true)
      toastError('Failed to save tag changes.')
    } finally {
      setTagSaving(false)
    }
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
    clearPendingRetry()
    setPlaybackError(false)
    setSelectedRendition(rendition)
    setQualityMenuOpen(false)
  }

  function handleLoadedMetadata() {
    const el = videoRef.current
    const resume = resumeStateRef.current
    retryCountRef.current = 0
    setPlaybackError(false)
    if (!el || !resume) {
      return
    }
    el.currentTime = resume.currentTime
    if (resume.wasPlaying) {
      el.play().catch(() => {})
    }
    resumeStateRef.current = null
  }

  function clearPendingRetry() {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }
  }

  // The browser's native "corrupt file" error can fire for a stall, an
  // aborted fetch, or a seek/quality-switch racing the server - not just an
  // actually corrupt file. Retry those transient codes with backoff before
  // treating playback as failed.
  function handlePlaybackError() {
    const el = videoRef.current
    if (!el || !el.error) {
      return
    }

    if (TRANSIENT_MEDIA_ERROR_CODES.has(el.error.code) && retryCountRef.current < RETRY_BACKOFF_MS.length) {
      const attempt = retryCountRef.current
      retryCountRef.current += 1
      if (!resumeStateRef.current) {
        resumeStateRef.current = { currentTime: el.currentTime, wasPlaying: !el.paused }
      }
      clearPendingRetry()
      retryTimeoutRef.current = setTimeout(() => {
        retryTimeoutRef.current = null
        videoRef.current?.load()
      }, RETRY_BACKOFF_MS[attempt])
      return
    }

    setPlaybackError(true)
  }

  function handleRetryPlayback() {
    retryCountRef.current = 0
    setPlaybackError(false)
    const el = videoRef.current
    if (el) {
      resumeStateRef.current = { currentTime: el.currentTime, wasPlaying: !el.paused }
      el.load()
    }
  }

  const memoizedSrc = useMemo(() => streamUrl, [streamUrl])

  // Element remounts on src change (key={memoizedSrc}) - drop any retry
  // timeout scheduled against the outgoing element.
  useEffect(() => clearPendingRetry, [memoizedSrc])

  function handleFirstPlay() {
    if (viewRecordedRef.current) {
      return
    }
    viewRecordedRef.current = true
    recordView(video.id).catch((err) => console.error('Failed to record view:', err))
  }

  function handleEnded() {
    if (autoplayEnabled) {
      setAutoplayCountdown(AUTOPLAY_COUNTDOWN_SECONDS)
    }
  }

  function handleCancelAutoplay() {
    onAutoplayChange?.(false)
  }

  // Ticks the overlay countdown down to 0 one second at a time, then hands
  // off to the parent to actually navigate to the next video.
  useEffect(() => {
    if (autoplayCountdown === null) {
      return undefined
    }
    if (autoplayCountdown === 0) {
      onAutoplayNext?.()
      return undefined
    }
    const timeout = setTimeout(() => {
      setAutoplayCountdown((count) => count - 1)
    }, 1000)
    return () => clearTimeout(timeout)
  }, [autoplayCountdown, onAutoplayNext])

  function applyReactionDelta(previousReaction, nextReaction) {
    setReactionDelta((prev) => ({
      likeCount: prev.likeCount
        + (nextReaction === 'like' ? 1 : 0)
        - (previousReaction === 'like' ? 1 : 0),
      dislikeCount: prev.dislikeCount
        + (nextReaction === 'dislike' ? 1 : 0)
        - (previousReaction === 'dislike' ? 1 : 0),
    }))
  }

  async function handleLike() {
    if (!user || reactionPending) {
      return
    }
    setReactionPending(true)
    try {
      const result = await likeVideo(video.id)
      const nextReaction = result.liked ? 'like' : result.disliked ? 'dislike' : null
      applyReactionDelta(reaction, nextReaction)
      setReaction(nextReaction)
    } catch (err) {
      console.error('Failed to like video:', err)
      toastError('Failed to like video.')
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
      const nextReaction = result.liked ? 'like' : result.disliked ? 'dislike' : null
      applyReactionDelta(reaction, nextReaction)
      setReaction(nextReaction)
    } catch (err) {
      console.error('Failed to dislike video:', err)
      toastError('Failed to dislike video.')
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
      toastError('Failed to delist video.')
    } finally {
      setDelistPending(false)
    }
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/video?v=${video.videoId}`)
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 1500)
    } catch (err) {
      console.error('Failed to copy link:', err)
      toastError('Failed to copy link.')
    }
  }

  async function handleToggleSubscribe() {
    if (subscribePending || subscribed === null) {
      return
    }
    setSubscribePending(true)
    try {
      const result = subscribed
        ? await unsubscribeFromUser(uploaderId)
        : await subscribeToUser(uploaderId)
      setSubscribed(result.subscribed)
    } catch (err) {
      console.error('Failed to update subscription:', err)
      toastError('Failed to update subscription.')
    } finally {
      setSubscribePending(false)
    }
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
              onEnded={handleEnded}
              onError={handlePlaybackError}
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
            onEnded={handleEnded}
            onError={handlePlaybackError}
          />
        )}
        {autoplayCountdown !== null && (
          <div className="video-player-autoplay-overlay">
            <div className="video-player-autoplay-spinner">
              <span className="video-player-autoplay-count">{autoplayCountdown}</span>
            </div>
            <p>Next video Autoplaying</p>
            <button
              type="button"
              className="video-player-autoplay-cancel-btn"
              onClick={handleCancelAutoplay}
            >
              Cancel
            </button>
          </div>
        )}
        {playbackError && (
          <div className="video-player-error-overlay">
            <TriangleAlert size={32} />
            <p>Playback failed. This is usually temporary.</p>
            <button type="button" className="video-player-error-retry-btn" onClick={handleRetryPlayback}>
              Retry
            </button>
          </div>
        )}
        <div className="video-player-controls-overlay">
          {renditions.length > 0 && (
            <div className="video-player-quality" ref={qualityMenuRef}>
              <button
                type="button"
                className={`video-player-icon-btn${qualityMenuOpen ? ' video-player-icon-btn-active' : ''}`}
                aria-label="Select video quality"
                title="Select video quality"
                onClick={() => setQualityMenuOpen((prev) => !prev)}
                ref={qualityToggleRef}
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
            title={loop ? 'Disable loop' : 'Enable loop'}
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
            <div className="video-player-uploader-row">
              <p className="video-player-uploader">
                <Link to={`/users/${video.uploader?.username}`}>{uploaderName}</Link>
              </p>
              {canSubscribe && (
                <button
                  type="button"
                  className={`video-player-subscribe-btn${subscribed ? ' video-player-subscribe-btn-active' : ''}`}
                  disabled={subscribed === null || subscribePending}
                  onClick={handleToggleSubscribe}
                >
                  {subscribed ? 'Unsubscribe' : 'Subscribe'}
                </button>
              )}
            </div>
            <p className="video-player-stats">
              {formatViewCount(video.viewCount)} &middot;{' '}
              <span className="video-player-visibility">{video.visibility}</span>
            </p>
            {video.description && (
              <p className="video-player-description">{video.description}</p>
            )}
            {(displayedTags.length > 0 || canEditTags) && (
              <div className="video-player-tags">
                {displayedTags.length > 0 && (!tagEditMode || !canRemoveTags) && (
                  <span className="video-player-tags-label">Tags: </span>
                )}
                {(!tagEditMode || !canRemoveTags) &&
                  displayedTags.map((tag) => (
                    <Link
                      key={tag}
                      to={`/search?q=${encodeURIComponent(tag)}`}
                      className="video-player-tag"
                    >
                      {tag}
                    </Link>
                  ))}
                {canEditTags && !tagEditMode && (
                  <button
                    type="button"
                    className="video-player-tag-edit-btn"
                    aria-label={canRemoveTags ? 'Edit tags' : 'Add tags'}
                    title={canRemoveTags ? 'Edit tags' : 'Add tags'}
                    onClick={() => setTagEditMode(true)}
                  >
                    <Pencil size={13} />
                  </button>
                )}
                {canEditTags && tagEditMode && (
                  <div className="video-player-tag-editor">
                    <ChipInput
                      chips={(canRemoveTags
                        ? [
                            ...displayedTags.filter((tag) => !pendingRemoveTags.includes(tag)),
                            ...pendingAddTags,
                          ]
                        : pendingAddTags
                      ).map((tag) => ({ key: tag, label: tag }))}
                      onRemove={removeEditorTag}
                      inputValue={tagInput}
                      onInputChange={setTagInput}
                      onAddFreeform={canAddTags ? addPendingTagFromInput : undefined}
                      placeholder={canAddTags ? 'Add tags (comma or Enter)' : ''}
                      inputMaxLength={MAX_TAG_LENGTH}
                    />
                    <div className="video-player-tag-editor-actions">
                      <button
                        type="button"
                        className="video-player-tag-save-btn"
                        disabled={tagSaving}
                        onClick={handleSaveTags}
                      >
                        {tagSaving ? 'Saving...' : 'Save'}
                      </button>
                      <button
                        type="button"
                        className="video-player-tag-cancel-btn"
                        disabled={tagSaving}
                        onClick={handleCancelTagEdit}
                      >
                        Cancel
                      </button>
                    </div>
                    {tagError && (
                      <span className="video-player-tag-error">Failed to save tag changes.</span>
                    )}
                  </div>
                )}
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
              title="Edit video"
            >
              <Pencil size={18} />
            </Link>
          )}
          {isModerator && (
            <button
              type="button"
              className="video-player-icon-btn"
              aria-label={delisted ? 'Video delisted' : 'Delist video'}
              title={delisted ? 'Video delisted' : 'Delist video'}
              disabled={delistPending || delisted}
              onClick={handleDelist}
            >
              <EyeOff size={18} />
            </button>
          )}
          {Boolean(user) && user.id !== uploaderId && (
            <button
              type="button"
              className="video-player-icon-btn"
              aria-label={hideError ? 'Hiding video failed, try again' : 'Hide Forever'}
              title={hideError ? 'Hiding video failed, try again' : 'Hide Forever'}
              onClick={handleHide}
            >
              <EyeClosed size={18} />
            </button>
          )}
          <button
            type="button"
            className="video-player-icon-btn"
            aria-label={linkCopied ? 'Link copied' : 'Copy video link'}
            title={linkCopied ? 'Link copied' : 'Copy video link'}
            onClick={handleCopyLink}
          >
            <LinkIcon size={18} />
          </button>
          <div className="video-player-add-to-playlist" ref={playlistMenuRef}>
            <button
              type="button"
              className={`video-player-icon-btn${playlistMenuOpen ? ' video-player-icon-btn-active' : ''}`}
              aria-label="Add to playlist"
              title="Add to playlist"
              disabled={!user}
              onClick={handleTogglePlaylistMenu}
              ref={playlistToggleRef}
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
              title="Remove from playlist"
              onClick={onRemoveFromPlaylist}
            >
              <ListMinus size={18} />
            </button>
          )}
          {onReport && (
            <button
              type="button"
              className="video-player-icon-btn"
              aria-label="Report"
              title="Report"
              onClick={onReport}
            >
              <TriangleAlert size={18} />
            </button>
          )}
          <div className="video-player-reaction-group">
            <div className="video-player-reaction-buttons">
              <button
                type="button"
                className={`video-player-icon-btn${reaction === 'like' ? ' video-player-icon-btn-like-active' : ''}`}
                aria-label="Like"
                title="Like"
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
                title="Dislike"
                aria-pressed={reaction === 'dislike'}
                disabled={!user || reactionPending}
                onClick={handleDislike}
              >
                <ThumbsDown size={18} />
              </button>
            </div>
            <ReactionScore
              likeCount={(video.likeCount ?? 0) + reactionDelta.likeCount}
              dislikeCount={(video.dislikeCount ?? 0) + reactionDelta.dislikeCount}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

export default VideoPlayer
