import { useEffect, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../context/useAuth.js'
import { useWatchParty } from '../context/useWatchParty.js'
import { useWatchPartyPlaybackSync } from '../hooks/useWatchPartyPlaybackSync.js'
import VideoPlayer from '../components/VideoPlayer.jsx'
import WatchPartyQueue from '../components/WatchPartyQueue.jsx'
import WatchPartyMembers from '../components/WatchPartyMembers.jsx'
import WatchPartyActivityFeed from '../components/WatchPartyActivityFeed.jsx'
import WatchPartyReactions from '../components/WatchPartyReactions.jsx'
import WatchPartyReactionBar from '../components/WatchPartyReactionBar.jsx'
import './WatchPartyPage.css'

/**
 * How long the "session has ended" message stays up before the member is
 * returned to the homepage.
 *
 * @type {number}
 */
const ENDED_REDIRECT_MS = 2000

/**
 * The member-facing Watch Party page (`/cast/:id`, rendered inside
 * AppLayout). Drives a VideoPlayer imperatively (via its ref) to follow the
 * session's server-authoritative playback clock - see
 * useWatchPartyPlaybackSync, shared with WatchPartyDisplayPage.
 */
function WatchPartyPage() {
  const { id } = useParams()
  const { user, loading: authLoading } = useAuth()
  const navigate = useNavigate()
  const {
    session,
    nowPlaying,
    playback,
    joinError,
    ended,
    enterSession,
    reportEnded,
    reportError,
    play,
    pause,
  } = useWatchParty()

  const videoPlayerRef = useRef(null)

  useEffect(() => {
    if (authLoading) {
      return undefined
    }
    if (!user) {
      navigate('/login')
      return undefined
    }
    enterSession(id)
    // Deliberately no cleanup: the session must outlive this page so it stays
    // in the TopBar popover while the user browses. Leaving is now an explicit
    // action (leaveSession), not a side effect of navigating away.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, user, authLoading])

  // Covers both "never got in" (an immediate join-ack failure) and "was in,
  // then kicked" (a live session:kicked event) - WatchPartyContext sets
  // joinError in both cases, so this is the one place that needs to react to
  // either.
  useEffect(() => {
    if (joinError) {
      navigate('/')
    }
  }, [joinError, navigate])

  // A normal end (owner or admin) rather than a failure: WatchPartyContext
  // has already cleared the session, so linger on the message just long
  // enough to read it, then get out of the dead page.
  useEffect(() => {
    if (!ended) {
      return undefined
    }
    const timer = setTimeout(() => navigate('/'), ENDED_REDIRECT_MS)
    return () => clearTimeout(timer)
  }, [ended, navigate])

  useWatchPartyPlaybackSync(videoPlayerRef, nowPlaying, playback)

  /**
   * Turns a pause/play from the player's own controls into a session command,
   * so the transport rail isn't the only thing that works. Any member may
   * control playback (controlPlayback enforces no ownership), matching the
   * rail's ungated buttons.
   *
   * Only acts when the local element has diverged from the server clock: when
   * useWatchPartyPlaybackSync pauses or plays the element to follow the
   * session, the resulting event already agrees with `playback`, so nothing
   * is emitted and there's no feedback loop - no suppression flag needed.
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

  if (ended) {
    return (
      <section className="watch-party-page">
        <p className="watch-party-page-status">This Watch Party has ended.</p>
      </section>
    )
  }

  if (!session) {
    return (
      <section className="watch-party-page">
        <p className="watch-party-page-status">Joining Watch Party…</p>
      </section>
    )
  }

  return (
    <section className="watch-party-page">
      <div className="watch-party-page-layout">
        <div className="watch-party-page-main">
          {nowPlaying ? (
            <div className="watch-party-page-player-frame">
              <VideoPlayer
                ref={videoPlayerRef}
                video={nowPlaying.video}
                onVideoEnded={() => reportEnded().catch(() => {})}
                onVideoError={() => reportError().catch(() => {})}
                onPlaybackIntent={handlePlaybackIntent}
              />
              <WatchPartyReactions />
            </div>
          ) : (
            <p className="watch-party-page-status">The queue is empty. Add a video to get started.</p>
          )}
          <WatchPartyReactionBar />
        </div>
        <div className="watch-party-page-sidebar">
          <WatchPartyQueue />
          <WatchPartyMembers />
          <WatchPartyActivityFeed />
        </div>
      </div>
    </section>
  )
}

export default WatchPartyPage
