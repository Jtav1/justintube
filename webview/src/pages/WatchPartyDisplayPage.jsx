import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../context/useAuth.js'
import { useWatchParty } from '../context/useWatchParty.js'
import { useWatchPartyPlaybackSync } from '../hooks/useWatchPartyPlaybackSync.js'
import VideoPlayer from '../components/VideoPlayer.jsx'
import WatchPartyReactions from '../components/WatchPartyReactions.jsx'
import './WatchPartyDisplayPage.css'

// Mirrors the dixtube-live prototype's HUD auto-hide delay.
const HUD_HIDE_DELAY_MS = 4000

/**
 * Chrome-less, fullscreen "cast to a TV" view (`/cast/:id/display`, outside
 * AppLayout - a logged-in member opens this and tab-casts/fullscreens it).
 * Shares WatchPartyPage's playback-sync logic (useWatchPartyPlaybackSync) but
 * adds two things a TV display specifically needs: an autoplay-block "click
 * to enable" overlay (browsers block autoplay-with-sound without a prior
 * user gesture, so this is required, not optional, for a freshly-opened tab
 * to ever start) and a HUD that auto-hides after inactivity.
 */
function WatchPartyDisplayPage() {
  const { id } = useParams()
  const { user, loading: authLoading } = useAuth()
  const navigate = useNavigate()
  const {
    session,
    nowPlaying,
    playback,
    members,
    joinError,
    ended,
    enterSession,
    play,
    pause,
  } = useWatchParty()

  const videoPlayerRef = useRef(null)
  const [hudVisible, setHudVisible] = useState(true)
  const [autoplayBlocked, setAutoplayBlocked] = useState(false)
  const hudTimeoutRef = useRef(null)

  // Resets the "blocked" flag whenever there's a new play attempt to
  // evaluate (a new video, or a play/pause/seek). Adjusted during render
  // (not the effect below) so this reset doesn't count as a synchronous
  // setState-in-effect - same pattern as SearchAutocomplete's `clearedFor`.
  const autoplayCheckKey = `${nowPlaying?.video?.videoId ?? ''}:${playback.status}:${playback.updatedAt ?? ''}`
  const [autoplayCheckedFor, setAutoplayCheckedFor] = useState(null)
  if (autoplayCheckKey !== autoplayCheckedFor) {
    setAutoplayCheckedFor(autoplayCheckKey)
    setAutoplayBlocked(false)
  }

  useEffect(() => {
    if (authLoading) {
      return
    }
    if (!user) {
      navigate('/login', { state: { from: `/cast/${id}/display` } })
      return
    }
    enterSession(id)
    // No cleanup here either - see WatchPartyPage for why.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, user, authLoading])

  // Covers both "never got in" and "was in, then kicked" - see
  // WatchPartyPage's identical guard for the full rationale.
  useEffect(() => {
    if (joinError) {
      navigate('/')
    }
  }, [joinError, navigate])

  useWatchPartyPlaybackSync(videoPlayerRef, nowPlaying, playback)

  /**
   * Mirrors WatchPartyPage: a pause/play on this screen's own controls drives
   * the session rather than being instantly reverted by the sync hook. Emits
   * only when the element has diverged from the server clock, so the hook's
   * own corrections don't echo back.
   *
   * @param {boolean} paused The element's new paused state.
   * @returns {void}
   */
  function handlePlaybackIntent(paused) {
    if (paused && playback.status === 'playing') {
      pause().catch(() => {})
    } else if (!paused && playback.status === 'paused') {
      play().catch(() => {})
    }
  }

  // Detects an autoplay-block: whenever the server clock says "playing" but
  // the local element is paused, try to start it and surface a full-screen
  // prompt on rejection (useWatchPartyPlaybackSync's own attempt at the same
  // call swallows this, since it has no UI to react with).
  useEffect(() => {
    if (playback.status !== 'playing' || !nowPlaying) {
      return
    }
    const state = videoPlayerRef.current?.getState()
    if (!state || !state.paused) {
      return
    }
    videoPlayerRef.current
      ?.play()
      ?.then(() => setAutoplayBlocked(false))
      ?.catch(() => setAutoplayBlocked(true))
  }, [playback, nowPlaying])

  function handleEnablePlayback() {
    videoPlayerRef.current
      ?.play()
      ?.then(() => setAutoplayBlocked(false))
      ?.catch(() => {})
  }

  useEffect(() => {
    function scheduleHide() {
      clearTimeout(hudTimeoutRef.current)
      hudTimeoutRef.current = setTimeout(() => setHudVisible(false), HUD_HIDE_DELAY_MS)
    }
    function handleActivity() {
      setHudVisible(true)
      scheduleHide()
    }
    scheduleHide()
    window.addEventListener('mousemove', handleActivity)
    window.addEventListener('touchstart', handleActivity)
    return () => {
      window.removeEventListener('mousemove', handleActivity)
      window.removeEventListener('touchstart', handleActivity)
      clearTimeout(hudTimeoutRef.current)
    }
  }, [])

  if (authLoading || !user) {
    return null
  }

  // No redirect here, unlike WatchPartyPage: this is the unattended TV view,
  // where bouncing to the homepage would be less use than saying what
  // happened.
  if (ended) {
    return (
      <div className="watch-party-display">
        <p className="watch-party-display-empty">This Watch Party has ended.</p>
      </div>
    )
  }

  return (
    <div className="watch-party-display">
      {nowPlaying ? (
        <VideoPlayer
          ref={videoPlayerRef}
          video={nowPlaying.video}
          onPlaybackIntent={handlePlaybackIntent}
        />
      ) : (
        <p className="watch-party-display-empty">Waiting for a video…</p>
      )}
      <WatchPartyReactions />

      {autoplayBlocked && (
        <button type="button" className="watch-party-display-enable" onClick={handleEnablePlayback}>
          Click to enable playback
        </button>
      )}

      <div className={`watch-party-display-hud${hudVisible ? '' : ' watch-party-display-hud-hidden'}`}>
        <p className="watch-party-display-title">{session?.title}</p>
        <p className="watch-party-display-meta">
          Code <strong>{session?.code}</strong> · {members.length} watching
        </p>
      </div>
    </div>
  )
}

export default WatchPartyDisplayPage
