import { useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import Hls from 'hls.js'
import { Radio } from 'lucide-react'
import { getLivestream, getLivestreamPlayback } from '../api/livestreams.js'
import { formatViewerCount } from '../lib/format.js'
import './LiveWatchPage.css'

/**
 * Watch page for a single livestream. Polls playback info while offline (so
 * it picks up the stream automatically once the streamer goes live) and
 * attaches hls.js to play the manifest once one is available - only Safari
 * plays HLS natively, so hls.js is required for Chrome/Firefox.
 */
function LiveWatchPage() {
  const { id } = useParams()
  const videoRef = useRef(null)
  const [livestream, setLivestream] = useState(null)
  const [playbackUrl, setPlaybackUrl] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const data = await getLivestream(id)
        if (!cancelled) {
          setLivestream(data)
        }
      } catch {
        if (!cancelled) {
          setError('This livestream is unavailable right now.')
        }
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [id])

  useEffect(() => {
    let cancelled = false
    let timeoutId

    async function poll() {
      try {
        const data = await getLivestreamPlayback(id)
        if (cancelled) return
        setPlaybackUrl(data.playbackUrl)
      } catch {
        if (!cancelled) {
          setPlaybackUrl(null)
        }
      }
      if (!cancelled) {
        timeoutId = setTimeout(poll, 15000)
      }
    }

    poll()
    return () => {
      cancelled = true
      clearTimeout(timeoutId)
    }
  }, [id])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !playbackUrl) return undefined

    if (Hls.isSupported()) {
      const hls = new Hls()
      hls.loadSource(playbackUrl)
      hls.attachMedia(video)
      return () => hls.destroy()
    }

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = playbackUrl
    }
    return undefined
  }, [playbackUrl])

  const streamerName = livestream?.streamer?.displayName || livestream?.streamer?.username

  return (
    <section className="live-watch-page">
      {error && <p className="live-watch-error">{error}</p>}
      {!error && livestream && (
        <div className="live-watch-layout">
          <div className="live-watch-player-wrap">
            {playbackUrl ? (
              <video ref={videoRef} className="live-watch-player" controls autoPlay />
            ) : (
              <div className="live-watch-offline">
                <Radio size={28} />
                <p>{streamerName} isn&apos;t live right now.</p>
              </div>
            )}
          </div>
          <div className="live-watch-info">
            <h1 className="live-watch-title">{livestream.title || 'Untitled stream'}</h1>
            <div className="live-watch-meta">
              <Link to={`/users/${livestream.streamer?.username}`} className="live-watch-streamer">
                {streamerName}
              </Link>
              {playbackUrl && (
                <span className="live-watch-viewers">
                  {formatViewerCount(livestream.viewerCount)}
                </span>
              )}
            </div>
            {livestream.description && (
              <p className="live-watch-description">{livestream.description}</p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

export default LiveWatchPage
