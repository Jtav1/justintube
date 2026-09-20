import { useEffect, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../context/useAuth.js'
import { useWatchParty } from '../context/useWatchParty.js'
import { useWatchPartyPlaybackSync } from '../hooks/useWatchPartyPlaybackSync.js'
import { useDocumentTitle } from '../hooks/useDocumentTitle.js'
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
    left,
    enterSession,
    reportEnded,
    reportError,
    play,
    pause,
    seek,
    getServerNow,
  } = useWatchParty()

  const videoPlayerRef = useRef(null)

  useDocumentTitle(nowPlaying?.video?.title ?? session?.title)

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

  // Leaving tears the session state down without any error, which would
  // otherwise drop this page into its "Joining Watch Party…" branch and leave
  // the user stranded there. The session keeps running for everyone else.
  useEffect(() => {
    if (left) {
      navigate('/')
    }
  }, [left, navigate])

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

  // The hook owns both directions: it drives the element to follow the session
  // clock, and hands back the handlers that turn this member's own play/pause
  // and scrubbing into session commands without echoing its own corrections.
  const { onPlaybackIntent, onSeekIntent } = useWatchPartyPlaybackSync(
    videoPlayerRef,
    nowPlaying,
    playback,
    { play, pause, seek, getServerNow },
  )

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
                onVideoEnded={() => reportEnded(nowPlaying.id).catch(() => {})}
                onVideoError={() => reportError(nowPlaying.id).catch(() => {})}
                onPlaybackIntent={onPlaybackIntent}
                onSeekIntent={onSeekIntent}
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
