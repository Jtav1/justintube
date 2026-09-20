import { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { SITE_NAME } from '../lib/document-title.js'
import {
  Airplay,
  Cast,
  Captions,
  EyeOff,
  EyeClosed,
  Link as LinkIcon,
  ListMinus,
  ListPlus,
  Maximize2,
  Minimize2,
  TriangleAlert,
  Pencil,
  Repeat,
  Settings2,
  ThumbsDown,
  ThumbsUp,
  UserRound,
  VideoOff,
} from 'lucide-react'
import { formatRelativeDate, formatViewCount } from '../lib/format.js'
import apiClient from '../api/client.js'
import {
  addVideoTags,
  removeVideoTags,
  delistVideo,
  dislikeVideo,
  likeVideo,
  listVideoSubtitles,
  recordView,
  hideVideo,
} from '../api/videos.js'
import { listCastDevices, playOnCastDevice } from '../api/cast-devices.js'
import { addVideoToPlaylist, listMyPlaylists } from '../api/playlists.js'
import { getSubscriptionState, subscribeToUser, unsubscribeFromUser } from '../api/users.js'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import { useSiteConfig } from '../context/useSiteConfig.js'
import { useDismissablePopover } from '../hooks/useDismissablePopover.js'
import { useTextOverflowShrink } from '../hooks/useTextOverflowShrink.js'
import { readVolume, writeVolume } from '../lib/volume.js'
import { loadCastSdk } from '../lib/cast-sdk.js'
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

// Seconds before end-of-video to fire onNearEnd (warms the autoplay-next target).
const NEAR_END_THRESHOLD_SECONDS = 15

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
  autoplayEnabled = false,
  onAutoplayNext,
  onAutoplayChange,
  onNearEnd,
  autoplayOnLoad = false,
  expanded = false,
  onToggleExpand,
  onVideoEnded,
  onVideoError,
  onAddToWatchPartyQueue,
  onPlaybackIntent,
  onSeekIntent,
  ref,
}) {
  const { user } = useAuth()
  const { error: toastError } = useToast()
  const { deviceCastEnabled } = useSiteConfig()
  const navigate = useNavigate()
  const renditions = video.renditions ?? []
  // Only ever set for an upload the server confirmed has no genuine video
  // stream (see webapi's enqueueAudioEmbedVideo) - a thumbnail image and the
  // audio muxed into a real playable MP4, purely so this player (and
  // link-unfurl bots) have something to show instead of a blank video area.
  // Its mere presence is the signal that this upload had no video stream to
  // begin with, so it's used in place of the original stream whenever it
  // exists, superseding mediaType for the audio-vs-video rendering choice.
  const embedVideoUrl = video.embedVideoUrl
    ? `${apiClient.defaults.baseURL}${video.embedVideoUrl}`
    : null
  const isAudio = video.mediaType === 'audio' && !embedVideoUrl
  const [selectedRendition, setSelectedRendition] = useState(() => pickDefaultRendition(renditions))
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false)
  const [loop, setLoop] = useState(false)
  const [reaction, setReaction] = useState(video.viewerReaction ?? null)
  const [reactionPending, setReactionPending] = useState(false)
  const [reactionDelta, setReactionDelta] = useState({ likeCount: 0, dislikeCount: 0 })
  // Reset per-video state together when `video` changes under a still-mounted
  // player (Watch Party only; VideoPage remounts per video). Without resetting
  // selectedRendition here, streamUrl kept pointing at the previous video's
  // stream while title/description/metadata moved on.
  const [perVideoStateId, setPerVideoStateId] = useState(video.id)
  if (video.id !== perVideoStateId) {
    setPerVideoStateId(video.id)
    setSelectedRendition(pickDefaultRendition(renditions))
    setReaction(video.viewerReaction ?? null)
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
  const [watchPartyQueued, setWatchPartyQueued] = useState(false)
  // castSdkAvailable reflects whether this browser has a working Google Cast
  // Web Sender SDK (Chrome/Edge only) - not whether a device is currently
  // available. See lib/cast-sdk.js for why this SDK is used over the W3C
  // Remote Playback API. The Cast button's visibility is gated on SDK
  // *support*; the SDK's own picker (behind the button itself) does the
  // real "is anything actually there" check, which requires a genuine user
  // gesture to open.
  const [castSdkAvailable, setCastSdkAvailable] = useState(false)
  const [airplayAvailable, setAirplayAvailable] = useState(false)
  const [castMenuOpen, setCastMenuOpen] = useState(false)
  // null = not fetched yet (renders "Looking for devices…"), [] = none found.
  const [castDevices, setCastDevices] = useState(null)
  const [castingTo, setCastingTo] = useState(null)
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

  const [subtitles, setSubtitles] = useState([])
  const [selectedSubtitleId, setSelectedSubtitleId] = useState(null)
  const [captionsMenuOpen, setCaptionsMenuOpen] = useState(false)

  const [playlistMenuOpen, setPlaylistMenuOpen] = useState(false)
  const [myPlaylists, setMyPlaylists] = useState(null)
  const [playlistsLoading, setPlaylistsLoading] = useState(false)
  const [playlistsError, setPlaylistsError] = useState(null)
  const [addStatus, setAddStatus] = useState({})

  const videoRef = useRef(null)
  const qualityMenuRef = useRef(null)
  const qualityToggleRef = useRef(null)
  const castMenuRef = useRef(null)
  const castToggleRef = useRef(null)
  const captionsMenuRef = useRef(null)
  const captionsToggleRef = useRef(null)
  const playlistMenuRef = useRef(null)
  const playlistToggleRef = useRef(null)
  const playlistDropdownRef = useRef(null)
  const resumeStateRef = useRef(null)
  // Set while a seek this component initiated is in flight, so handleSeeked can
  // tell its own work from the user dragging the progress bar.
  const programmaticSeekRef = useRef(false)
  // The playback rate an external controller asked for (CAST drift correction),
  // re-applied after the element remounts.
  const desiredRateRef = useRef(1)

  /**
   * Moves the playhead on this component's own behalf, flagging it so
   * handleSeeked doesn't report it as the user scrubbing.
   *
   * Skips the assignment when the element is already there: that fires no
   * `seeked` event, which would leave the flag raised and swallow the user's
   * next real scrub.
   *
   * @param {HTMLMediaElement} el The media element.
   * @param {number} seconds Target position.
   * @returns {void}
   */
  function applyProgrammaticSeek(el, seconds) {
    if (Math.abs(el.currentTime - seconds) < 0.01) {
      return
    }
    programmaticSeekRef.current = true
    el.currentTime = seconds
  }
  const retryCountRef = useRef(0)
  const retryTimeoutRef = useRef(null)
  const viewRecordedRef = useRef(false)
  const nearEndFiredRef = useRef(false)
  const titleRef = useRef(null)
  const titleShrunk = useTextOverflowShrink(titleRef, video.title, {
    fontSize: TITLE_FONT_SIZE,
    fontWeight: TITLE_FONT_WEIGHT,
  })
  const measureCanvasRef = useRef(null)

  // External imperative control surface for Watch Party (see
  // WatchPartyPage/WatchPartyDisplayPage):
  // synced playback needs to drive play/pause/seek from outside this
  // component's own controls. `seek` reuses the exact same
  // resumeStateRef/handleLoadedMetadata mechanism the quality-switch flow
  // above relies on, so a seek requested right as `video` changes (and the
  // element remounts via `key={memoizedSrc}`, not yet ready) is queued and
  // applied automatically once metadata loads, instead of silently no-oping
  // against an element that hasn't loaded anything yet.
  useImperativeHandle(ref, () => ({
    // Deliberately does not swallow a rejection here (unlike the internal
    // autoplay/seek call sites below) - WatchPartyDisplayPage needs to detect an
    // autoplay-block rejection to show its "click to enable" overlay.
    // Callers that don't care can just add their own .catch(() => {}).
    play() {
      return videoRef.current?.play()
    },
    pause() {
      videoRef.current?.pause()
    },
    seek(seconds, { play: shouldPlay } = {}) {
      const el = videoRef.current
      if (!el) return
      if (el.readyState >= 1) {
        // Flagged so the resulting `seeked` event isn't mistaken for the user
        // scrubbing - otherwise every CAST drift correction would echo straight
        // back out as a session-wide seek.
        applyProgrammaticSeek(el, seconds)
        if (shouldPlay === true) el.play().catch(() => {})
        if (shouldPlay === false) el.pause()
      } else {
        resumeStateRef.current = { currentTime: seconds, wasPlaying: shouldPlay ?? false }
      }
    },
    setPlaybackRate(rate) {
      // Remembered as well as applied: the element remounts on a video or
      // quality change (key={memoizedSrc}), which resets rate to 1, and
      // handleLoadedMetadata puts this back.
      desiredRateRef.current = rate
      const el = videoRef.current
      if (el) el.playbackRate = rate
    },
    getState() {
      const el = videoRef.current
      return {
        currentTime: el?.currentTime ?? 0,
        paused: el?.paused ?? true,
        // The caller needs these to know whether the element is in any state to
        // be corrected - seeking or starved of data, measuring it is meaningless.
        seeking: el?.seeking ?? false,
        readyState: el?.readyState ?? 0,
        playbackRate: el?.playbackRate ?? 1,
        duration: Number.isFinite(el?.duration) ? el.duration : null,
        // Whether a remote device (AirPlay/Chromecast) is actively rendering
        // this element, as opposed to merely available. Consumed by
        // useWatchPartyPlaybackSync, which pauses rate-nudging while true
        // since the receiver owns playback and re-syncs on every write.
        remote: Boolean(
          el?.webkitCurrentPlaybackTargetIsWireless || el?.remote?.state === 'connected',
        ),
      }
    },
  }), [])

  const streamUrl = embedVideoUrl
    ? embedVideoUrl
    : selectedRendition
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

  // Publishes what's playing to the OS/browser: the AirPlay receiver's "now
  // playing" title, the lock screen, Control Center, media keys. Without it an
  // Apple TV falls back to the page title, which used to be the generic route
  // label. Artwork is fetched by the browser without credentials, so a private
  // video's thumbnail may simply not load - the title still does.
  useEffect(() => {
    if (!('mediaSession' in navigator)) {
      return undefined
    }
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: video.title ?? '',
      artist: uploaderName ?? '',
      album: SITE_NAME,
      artwork: video.thumbnailUrl
        ? [{ src: `${apiClient.defaults.baseURL}${video.thumbnailUrl}` }]
        : [],
    })
    return () => {
      navigator.mediaSession.metadata = null
    }
  }, [video.title, video.thumbnailUrl, uploaderName])

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

  useDismissablePopover(qualityMenuOpen, () => setQualityMenuOpen(false), qualityToggleRef, {
    dismissRefs: [qualityMenuRef],
  })

  useEffect(() => {
    if (!castMenuOpen) {
      return undefined
    }

    function handleClickOutside(event) {
      if (castMenuRef.current && !castMenuRef.current.contains(event.target)) {
        setCastMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [castMenuOpen])

  useDismissablePopover(castMenuOpen, () => setCastMenuOpen(false), castToggleRef)

  // Refetches whenever the video itself changes (not on a quality switch -
  // the subtitle list is the same across renditions of the same video).
  useEffect(() => {
    let cancelled = false
    setSubtitles([])
    setSelectedSubtitleId(null)
    listVideoSubtitles(video.id)
      .then((data) => {
        if (!cancelled) {
          setSubtitles(data.items ?? [])
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSubtitles([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [video.id])

  useDismissablePopover(captionsMenuOpen, () => setCaptionsMenuOpen(false), captionsToggleRef, {
    dismissRefs: [captionsMenuRef],
  })

  useDismissablePopover(playlistMenuOpen, () => setPlaylistMenuOpen(false), playlistToggleRef, {
    dismissRefs: [playlistMenuRef],
  })

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
    if (!el) {
      return
    }
    // A fresh element starts at rate 1, so an external controller's chosen rate
    // (CAST drift correction) has to be re-applied on every remount.
    if (desiredRateRef.current !== 1) {
      el.playbackRate = desiredRateRef.current
    }
    if (!resume) {
      return
    }
    applyProgrammaticSeek(el, resume.currentTime)
    if (resume.wasPlaying) {
      el.play().catch(() => {})
    }
    resumeStateRef.current = null
  }

  // A `seeked` this component caused (drift correction, a quality-switch resume)
  // is not the user's intent, so only a genuine scrub is reported upwards - see
  // the programmaticSeekRef comment on the imperative seek().
  function handleSeeked(event) {
    if (programmaticSeekRef.current) {
      programmaticSeekRef.current = false
      return
    }
    onSeekIntent?.(event.currentTarget.currentTime)
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
    onVideoError?.()
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

  // The media element remounts fresh (key={memoizedSrc}) on every video
  // change *and* every quality switch, resetting .volume to the browser
  // default each time - reapply the user's saved preference whenever that
  // happens rather than only on this component's own mount.
  useEffect(() => {
    const el = videoRef.current
    if (el) {
      el.volume = readVolume()
    }
  }, [memoizedSrc])

  // Watches for AirPlay availability. Keyed on memoizedSrc because the media
  // element remounts on every src/quality change, so the listener has to be
  // re-attached to the new element.
  useEffect(() => {
    const el = videoRef.current
    if (!el) {
      return undefined
    }

    let cancelled = false

    // AirPlay is WebKit-only and predates the standard API, hence the separate
    // vendor-prefixed event and picker.
    const supportsAirplay = typeof el.webkitShowPlaybackTargetPicker === 'function'
    function handleAirplayAvailability(event) {
      if (!cancelled) {
        setAirplayAvailable(event.availability === 'available')
      }
    }
    if (supportsAirplay) {
      el.addEventListener('webkitplaybacktargetavailabilitychanged', handleAirplayAvailability)
    }

    return () => {
      cancelled = true
      if (supportsAirplay) {
        el.removeEventListener('webkitplaybacktargetavailabilitychanged', handleAirplayAvailability)
      }
    }
  }, [memoizedSrc])

  // Loads the Cast SDK once (module-level singleton, see lib/cast-sdk.js) -
  // mount-only, unlike the AirPlay watcher above, since SDK availability
  // doesn't depend on which video is loaded.
  useEffect(() => {
    let cancelled = false
    loadCastSdk().then((available) => {
      if (!cancelled) {
        setCastSdkAvailable(available)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Opens the Google Cast device picker via the Cast Sender SDK (see
   * lib/cast-sdk.js) and hands the current video off to whatever receiver
   * the user picks, using the account-less built-in Default Media Receiver -
   * no custom receiver app needed. Dismissing the picker is a normal outcome
   * and stays silent; every other failure is reported, since a picker that
   * never appears is otherwise indistinguishable from a button that does
   * nothing.
   *
   * Chrome's Cast plumbing needs genuine media engagement before it'll
   * search for devices at all, so play() runs first, in the same click
   * gesture.
   */
  async function handleCastSdkPrompt() {
    const el = videoRef.current
    if (!window.cast?.framework) {
      toastError("This browser can't cast this video.")
      return
    }
    try {
      //await el?.play()
      const context = window.cast.framework.CastContext.getInstance()
      const requestError = await context.requestSession()
      if (requestError) {
        // The user closed the picker without choosing a device.
        if (requestError !== window.chrome.cast.ErrorCode.CANCEL) {
          console.error('Cast session request failed:', requestError)
          toastError('Could not open the cast picker.')
        }
        return
      }
      const session = context.getCurrentSession()
      if (!session) {
        return
      }
      const mediaInfo = new window.chrome.cast.media.MediaInfo(
        memoizedSrc,
        selectedRendition?.mimeType || 'video/mp4',
      )
      mediaInfo.metadata = new window.chrome.cast.media.GenericMediaMetadata()
      mediaInfo.metadata.title = video.title ?? ''
      const loadError = await session.loadMedia(new window.chrome.cast.media.LoadRequest(mediaInfo))
      if (loadError) {
        console.error('Cast load media failed:', loadError)
        toastError('Could not start casting this video.')
        return
      }
      el?.pause()
    } catch (err) {
      console.error('Cast session failed:', err)
      toastError('Could not open the cast picker.')
    }
  }

  /**
   * Opens the cast menu. With server-side casting available the menu lists
   * devices the API discovered; without it, there's nothing to list, so go
   * straight to the Cast SDK's own picker.
   */
  function handleCastClick() {
    if (!deviceCastEnabled) {
      handleCastSdkPrompt()
      return
    }
    if (castMenuOpen) {
      setCastMenuOpen(false)
      return
    }
    setCastMenuOpen(true)
    setCastDevices(null)
    listCastDevices()
      .then((data) => setCastDevices(data.items ?? []))
      .catch(() => {
        setCastDevices([])
        toastError('Failed to look for cast devices.')
      })
  }

  /**
   * Hands playback to a device. The server connects to it and tells it to
   * fetch the media itself, so nothing streams through the browser.
   *
   * @param {{id: string, name: string}} device Target device.
   */
  async function handleCastToDevice(device) {
    setCastingTo(device.id)
    try {
      await playOnCastDevice(device.id, video.videoId)
      setCastMenuOpen(false)
      videoRef.current?.pause()
    } catch (err) {
      const message = err.response?.data?.message
      toastError(message || `Failed to cast to ${device.name}.`)
    } finally {
      setCastingTo(null)
    }
  }

  /**
   * Opens Safari's AirPlay target picker.
   */
  function handleAirPlay() {
    try {
      videoRef.current?.webkitShowPlaybackTargetPicker()
    } catch {
      toastError('Could not open the AirPlay picker.')
    }
  }

  function handleVolumeChange() {
    const el = videoRef.current
    if (el) {
      writeVolume(el.volume)
    }
  }

  // The media element (and its <track> children, if any) remounts fresh on
  // every video change and every quality switch (key={memoizedSrc}) - a
  // freshly mounted track's .mode isn't reliably "hidden" by default across
  // browsers, so pin every one explicitly and reset the selection to match,
  // rather than letting them drift apart across a remount.
  useEffect(() => {
    const el = videoRef.current
    if (el) {
      for (const track of el.textTracks) {
        track.mode = 'hidden'
      }
    }
    setSelectedSubtitleId(null)
  }, [memoizedSrc])

  function handleSelectSubtitle(subtitleId) {
    const el = videoRef.current
    if (el) {
      const activeIndex = subtitles.findIndex((s) => s.id === subtitleId)
      Array.from(el.textTracks).forEach((track, index) => {
        track.mode = index === activeIndex ? 'showing' : 'hidden'
      })
    }
    setSelectedSubtitleId(subtitleId)
    setCaptionsMenuOpen(false)
  }

  // <audio> has no visual surface for a <track>'s cues to render onto (only
  // <video> gets the browser's built-in burned-in caption rendering), so for
  // the audio-only player, the active cue's text is tracked here and shown
  // as a plain text row instead (video-player-audio-caption below).
  const [activeCueText, setActiveCueText] = useState('')

  useEffect(() => {
    const el = videoRef.current
    if (!isAudio || !el || selectedSubtitleId == null) {
      setActiveCueText('')
      return undefined
    }
    const activeIndex = subtitles.findIndex((s) => s.id === selectedSubtitleId)
    const track = el.textTracks[activeIndex]
    if (!track) {
      return undefined
    }

    function updateActiveCue() {
      const cue = track.activeCues && track.activeCues[0]
      setActiveCueText(cue ? String(cue.text).replace(/<[^>]*>/g, '') : '')
    }

    track.addEventListener('cuechange', updateActiveCue)
    updateActiveCue()
    return () => {
      track.removeEventListener('cuechange', updateActiveCue)
    }
  }, [isAudio, selectedSubtitleId, subtitles, memoizedSrc])

  function handleFirstPlay() {
    onPlaybackIntent?.(false)
    if (viewRecordedRef.current) {
      return
    }
    viewRecordedRef.current = true
    recordView(video.id).catch((err) => console.error('Failed to record view:', err))
  }

  function handlePause() {
    onPlaybackIntent?.(true)
  }

  function handleEnded() {
    onVideoEnded?.()
    if (autoplayEnabled) {
      setAutoplayCountdown(AUTOPLAY_COUNTDOWN_SECONDS)
    }
  }

  // Reset once per video so onNearEnd can fire again for the next one.
  useEffect(() => {
    nearEndFiredRef.current = false
  }, [video.id])

  function handleTimeUpdate(event) {
    if (nearEndFiredRef.current || !onNearEnd) {
      return
    }
    const el = event.currentTarget
    if (!el.duration || Number.isNaN(el.duration)) {
      return
    }
    const remaining = el.duration - el.currentTime
    if (remaining <= NEAR_END_THRESHOLD_SECONDS) {
      nearEndFiredRef.current = true
      onNearEnd()
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

  async function handleAddToWatchPartyQueue() {
    try {
      await onAddToWatchPartyQueue()
      setWatchPartyQueued(true)
      setTimeout(() => setWatchPartyQueued(false), 1500)
    } catch (err) {
      toastError(err.message || 'Failed to add to the Watch Party queue.')
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
              title={video.title ?? undefined}
              loop={loop}
              crossOrigin={subtitles.length > 0 ? 'use-credentials' : undefined}
              x-webkit-airplay="allow"
              className="video-player-audio-element"
              onLoadedMetadata={handleLoadedMetadata}
              onPlay={handleFirstPlay}
              onPause={handlePause}
              onSeeked={handleSeeked}
              onEnded={handleEnded}
              onTimeUpdate={handleTimeUpdate}
              onVolumeChange={handleVolumeChange}
              onError={handlePlaybackError}
            >
              {subtitles.map((subtitle) => (
                <track
                  key={subtitle.id}
                  kind="subtitles"
                  label={subtitle.label}
                  src={`${apiClient.defaults.baseURL}${subtitle.url}`}
                />
              ))}
            </audio>
            {selectedSubtitleId != null && activeCueText && (
              <p className="video-player-audio-caption">{activeCueText}</p>
            )}
          </div>
        ) : (
          <video
            ref={videoRef}
            key={memoizedSrc}
            src={memoizedSrc}
            controls
            // Some AirPlay receivers read the element's own title rather than
            // the Media Session metadata, so both are set.
            title={video.title ?? undefined}
            loop={loop}
            crossOrigin={subtitles.length > 0 ? 'use-credentials' : undefined}
            x-webkit-airplay="allow"
            onLoadedMetadata={handleLoadedMetadata}
            onPlay={handleFirstPlay}
            onPause={handlePause}
            onSeeked={handleSeeked}
            onEnded={handleEnded}
            onTimeUpdate={handleTimeUpdate}
            onVolumeChange={handleVolumeChange}
            onError={handlePlaybackError}
          >
            {subtitles.map((subtitle) => (
              <track
                key={subtitle.id}
                kind="subtitles"
                label={subtitle.label}
                src={`${apiClient.defaults.baseURL}${subtitle.url}`}
              />
            ))}
          </video>
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
          {/* The embed video is a single fixed asset (no alternate
              qualities) - quality selection doesn't apply while it's in use. */}
          {!embedVideoUrl && renditions.length > 0 && (
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
          {onAddToWatchPartyQueue && (
            <button
              type="button"
              className="video-player-icon-btn"
              aria-label={watchPartyQueued ? 'Added to Watch Party queue' : 'Add to Watch Party queue'}
              title={watchPartyQueued ? 'Added to Watch Party queue' : 'Add to Watch Party queue'}
              onClick={handleAddToWatchPartyQueue}
            >
              <ListPlus size={18} />
            </button>
          )}
          {(deviceCastEnabled || castSdkAvailable) && (
            <div className="video-player-cast" ref={castMenuRef}>
              <button
                type="button"
                className={`video-player-icon-btn${castMenuOpen ? ' video-player-icon-btn-active' : ''}`}
                aria-label="Cast to a device"
                title="Cast to a device"
                onClick={handleCastClick}
                ref={castToggleRef}
              >
                <Cast size={18} />
              </button>
              {castMenuOpen && (
                <div className="video-player-cast-dropdown">
                  {castDevices === null && (
                    <p className="video-player-cast-status">Looking for devices…</p>
                  )}
                  {castDevices?.length === 0 && (
                    <p className="video-player-cast-status">No devices found.</p>
                  )}
                  {castDevices?.map((device) => (
                    <button
                      key={device.id}
                      type="button"
                      className="video-player-cast-item"
                      disabled={castingTo === device.id}
                      onClick={() => handleCastToDevice(device)}
                    >
                      {castingTo === device.id ? `Casting to ${device.name}…` : device.name}
                    </button>
                  ))}
                  {castSdkAvailable && (
                    <button
                      type="button"
                      className="video-player-cast-item"
                      onClick={() => {
                        setCastMenuOpen(false)
                        handleCastSdkPrompt()
                      }}
                    >
                      Use browser picker…
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {airplayAvailable && (
            <button
              type="button"
              className="video-player-icon-btn"
              aria-label="AirPlay"
              title="AirPlay"
              onClick={handleAirPlay}
            >
              <Airplay size={18} />
            </button>
          )}
          {subtitles.length > 0 && (
            <div className="video-player-captions" ref={captionsMenuRef}>
              <button
                type="button"
                className={`video-player-icon-btn${
                  captionsMenuOpen || selectedSubtitleId != null ? ' video-player-icon-btn-active' : ''
                }`}
                aria-label="Select captions"
                title="Select captions"
                aria-pressed={selectedSubtitleId != null}
                onClick={() => setCaptionsMenuOpen((prev) => !prev)}
                ref={captionsToggleRef}
              >
                <Captions size={18} />
              </button>
              {captionsMenuOpen && (
                <div className="video-player-captions-dropdown">
                  <button
                    type="button"
                    className={`video-player-captions-item${
                      selectedSubtitleId == null ? ' video-player-captions-item-active' : ''
                    }`}
                    onClick={() => handleSelectSubtitle(null)}
                  >
                    Off
                  </button>
                  {subtitles.map((subtitle) => (
                    <button
                      key={subtitle.id}
                      type="button"
                      className={`video-player-captions-item${
                        subtitle.id === selectedSubtitleId ? ' video-player-captions-item-active' : ''
                      }`}
                      onClick={() => handleSelectSubtitle(subtitle.id)}
                    >
                      {subtitle.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {onToggleExpand && (
            <button
              type="button"
              className={`video-player-icon-btn${expanded ? ' video-player-icon-btn-active' : ''}`}
              aria-label={expanded ? 'Collapse player' : 'Expand player'}
              title={expanded ? 'Collapse player' : 'Expand player'}
              aria-pressed={expanded}
              onClick={onToggleExpand}
            >
              {expanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </button>
          )}
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
              <span title={new Date(video.createdAt).toLocaleString()}>
                {formatRelativeDate(video.createdAt)}
              </span>{' '}
              &middot;{' '}
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
