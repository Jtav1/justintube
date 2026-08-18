import { useEffect, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../context/useAuth.js'
import { useCast } from '../context/useCast.js'
import { useCastPlaybackSync } from '../hooks/useCastPlaybackSync.js'
import VideoPlayer from '../components/VideoPlayer.jsx'
import CastQueue from '../components/CastQueue.jsx'
import CastMembers from '../components/CastMembers.jsx'
import CastActivityFeed from '../components/CastActivityFeed.jsx'
import CastReactions from '../components/CastReactions.jsx'
import './CastPage.css'

/**
 * The member-facing CAST watch page (`/cast/:id`, rendered inside AppLayout).
 * Drives a VideoPlayer imperatively (via its ref) to follow the session's
 * server-authoritative playback clock - see useCastPlaybackSync, shared with
 * CastDisplayPage.
 */
function CastPage() {
  const { id } = useParams()
  const { user, loading: authLoading } = useAuth()
  const navigate = useNavigate()
  const {
    session,
    nowPlaying,
    playback,
    joinError,
    enterSession,
    leaveActiveSession,
    reportEnded,
    reportError,
    sendReaction,
  } = useCast()

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
    return () => {
      leaveActiveSession()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, user, authLoading])

  // Covers both "never got in" (an immediate join-ack failure) and "was in,
  // then kicked" (a live session:kicked event) - CastContext sets joinError
  // in both cases, so this is the one place that needs to react to either.
  useEffect(() => {
    if (joinError) {
      navigate('/')
    }
  }, [joinError, navigate])

  useCastPlaybackSync(videoPlayerRef, nowPlaying, playback)

  if (!session) {
    return (
      <section className="cast-page">
        <p className="cast-page-status">Joining CAST session…</p>
      </section>
    )
  }

  if (session.status === 'ended') {
    return (
      <section className="cast-page">
        <p className="cast-page-status">This CAST session has ended.</p>
      </section>
    )
  }

  return (
    <section className="cast-page">
      <div className="cast-page-layout">
        <div className="cast-page-main">
          {nowPlaying ? (
            <div className="cast-page-player-frame">
              <VideoPlayer
                ref={videoPlayerRef}
                video={nowPlaying.video}
                onVideoEnded={() => reportEnded().catch(() => {})}
                onVideoError={() => reportError().catch(() => {})}
              />
              <CastReactions />
            </div>
          ) : (
            <p className="cast-page-status">The queue is empty. Add a video to get started.</p>
          )}
          <div className="cast-page-reaction-bar">
            {['👍', '😂', '😮', '❤️', '🎉', '👎'].map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="cast-page-reaction-btn"
                onClick={() => sendReaction(emoji)}
                aria-label={`React with ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
        <div className="cast-page-sidebar">
          <CastQueue />
          <CastMembers />
          <CastActivityFeed />
        </div>
      </div>
    </section>
  )
}

export default CastPage
