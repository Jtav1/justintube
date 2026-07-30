import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { getVideo } from '../api/videos.js'
import VideoPlayer from '../components/VideoPlayer.jsx'
import VideoComments from '../components/VideoComments.jsx'
import VideoSuggested from '../components/VideoSuggested.jsx'
import './VideoPage.css'

function VideoPage() {
  const [searchParams] = useSearchParams()
  const videoId = searchParams.get('v')

  const [video, setVideo] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const data = await getVideo(videoId)
        if (!cancelled) {
          setVideo(data)
        }
      } catch {
        if (!cancelled) {
          setError('Failed to load video.')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    if (videoId) {
      load()
    } else {
      setLoading(false)
      setError('No video specified.')
    }

    return () => {
      cancelled = true
    }
  }, [videoId])

  return (
    <section className="video-page">
      {error && <p className="video-page-error">{error}</p>}
      {!loading && !error && video && (
        <div className="video-page-layout">
          <div className="video-page-main">
            <VideoPlayer video={video} />
            <VideoComments video={video} />
          </div>
          <VideoSuggested video={video} />
        </div>
      )}
    </section>
  )
}

export default VideoPage
