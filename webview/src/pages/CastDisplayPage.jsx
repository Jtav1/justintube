import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../context/useAuth.js'
import { useCast } from '../context/useCast.js'
import { useCastPlaybackSync } from '../hooks/useCastPlaybackSync.js'
import VideoPlayer from '../components/VideoPlayer.jsx'
import CastReactions from '../components/CastReactions.jsx'
import './CastDisplayPage.css'

// Mirrors the dixtube-live prototype's HUD auto-hide delay.
const HUD_HIDE_DELAY_MS = 4000

/**
 * Chrome-less, fullscreen "cast to a TV" view (`/cast/:id/display`, outside
 * AppLayout - a logged-in member opens this and tab-casts/fullscreens it).
 * Shares CastPage's playback-sync logic (useCastPlaybackSync) but adds two
 * things a TV display specifically needs: an autoplay-block "click to
 * enable" overlay (browsers block autoplay-with-sound without a prior user
 * gesture, so this is required, not optional, for a freshly-opened tab to
 * ever start) and a HUD that auto-hides after inactivity.
 */
function CastDisplayPage() {
  const { id } = useParams()
  const { user, loading: authLoading } = useAuth()
  const navigate = useNavigate()
  const { session, nowPlaying, playback, members, joinError, enterSession, leaveActiveSession } =
    useCast()

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
    return () => {
      leaveActiveSession()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, user, authLoading])

  // Covers both "never got in" and "was in, then kicked" - see CastPage's
  // identical guard for the full rationale.
  useEffect(() => {
    if (joinError) {
      navigate('/')
    }
  }, [joinError, navigate])

  useCastPlaybackSync(videoPlayerRef, nowPlaying, playback)

  // Detects an autoplay-block: whenever the server clock says "playing" but
  // the local element is paused, try to start it and surface a full-screen
  // prompt on rejection (useCastPlaybackSync's own attempt at the same call
  // swallows this, since it has no UI to react with).
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

  return (
    <div className="cast-display">
      {nowPlaying ? (
        <VideoPlayer ref={videoPlayerRef} video={nowPlaying.video} />
      ) : (
        <p className="cast-display-empty">Waiting for a video…</p>
      )}
      <CastReactions />

      {autoplayBlocked && (
        <button type="button" className="cast-display-enable" onClick={handleEnablePlayback}>
          Click to enable playback
        </button>
      )}

      <div className={`cast-display-hud${hudVisible ? '' : ' cast-display-hud-hidden'}`}>
        <p className="cast-display-title">{session?.title}</p>
        <p className="cast-display-meta">
          Code <strong>{session?.code}</strong> · {members.length} watching
        </p>
      </div>
    </div>
  )
}

export default CastDisplayPage
