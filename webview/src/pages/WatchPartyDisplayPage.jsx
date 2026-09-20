import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../context/useAuth.js'
import { useWatchParty } from '../context/useWatchParty.js'
import { useWatchPartyPlaybackSync } from '../hooks/useWatchPartyPlaybackSync.js'
import { useDocumentTitle } from '../hooks/useDocumentTitle.js'
import VideoPlayer from '../components/VideoPlayer.jsx'
import WatchPartyReactions from '../components/WatchPartyReactions.jsx'
import RevealableSecret from '../components/RevealableSecret.jsx'
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
    left,
    enterSession,
    play,
    pause,
    seek,
    getServerNow,
    reportEnded,
    reportError,
  } = useWatchParty()

  const videoPlayerRef = useRef(null)
  const [hudVisible, setHudVisible] = useState(true)
  const [autoplayBlocked, setAutoplayBlocked] = useState(false)
  const hudTimeoutRef = useRef(null)

  // This view is the one people actually cast to a TV, so the title matters most
  // here - it's what the receiver shows. Outside AppLayout, so useRouteAnnouncer
  // never ran for it and nothing set a title at all before.
  useDocumentTitle(nowPlaying?.video?.title ?? session?.title)

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

  // Leaving from elsewhere in the app (the TopBar popover) clears the session
  // with no error, so this screen has to get itself out of the way too.
  useEffect(() => {
    if (left) {
      navigate('/')
    }
  }, [left, navigate])

  // Same both-directions wiring as WatchPartyPage - see the hook for why the
  // intent handlers live there rather than being duplicated per page.
  const { onPlaybackIntent, onSeekIntent } = useWatchPartyPlaybackSync(
    videoPlayerRef,
    nowPlaying,
    playback,
    { play, pause, seek, getServerNow },
  )

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
    // Keyed on autoplayCheckKey, not on `playback` itself: the server ticks once
    // a second and hands back a fresh playback object every time, so this probe
    // - and the play() call in it, racing the sync hook's own - used to re-run
    // every single second. The key only changes on something worth re-probing:
    // a new video, or a real play/pause/seek. (playback.status is listed too
    // because the rule requires it; being a primitive, it costs nothing.)
  }, [autoplayCheckKey, nowPlaying, playback.status])

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
          // Without these the queue stalls on a display-only setup: this is the
          // unattended TV view, so there may be no member tab open anywhere to
          // notice the video ended and tell the server to advance.
          onVideoEnded={() => reportEnded(nowPlaying.id).catch(() => {})}
          onVideoError={() => reportError(nowPlaying.id).catch(() => {})}
          onPlaybackIntent={onPlaybackIntent}
          onSeekIntent={onSeekIntent}
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
          Code{' '}
          <RevealableSecret label="join code">
            <strong>{session?.code}</strong>
          </RevealableSecret>
          {' '}· {members.length} watching
        </p>
      </div>
    </div>
  )
}

export default WatchPartyDisplayPage
