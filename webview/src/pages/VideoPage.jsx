import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { getVideo, unhideVideo } from '../api/videos.js'
import { getPlaylist, removePlaylistItem } from '../api/playlists.js'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import VideoPlayer from '../components/VideoPlayer.jsx'
import VideoComments from '../components/VideoComments.jsx'
import VideoSuggested from '../components/VideoSuggested.jsx'
import PlaylistQueue from '../components/PlaylistQueue.jsx'
import './VideoPage.css'

function VideoPage() {
  const { user } = useAuth()
  const { error: toastError } = useToast()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const videoId = searchParams.get('v')
  const playlistId = searchParams.get('list')
  // Set by TopBar's Random Video button (`?random=1`) so this page knows the
  // viewer arrived via shuffle, not a normal link/search click. Not yet used
  // for anything - reserved for future random-specific behavior (e.g. a
  // "shuffle again" affordance).
  const cameFromRandom = searchParams.get('random') === '1'

  const [video, setVideo] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [hiddenByViewer, setHiddenByViewer] = useState(false)
  const [playlist, setPlaylist] = useState(null)
  const [reloadCount, setReloadCount] = useState(0)

  useEffect(() => {
    let cancelled = false

    async function load() {
      if (!videoId) {
        setLoading(false)
        setError('No video specified.')
        return
      }
      setLoading(true)
      setError(null)
      setHiddenByViewer(false)
      try {
        const data = await getVideo(videoId)
        if (!cancelled) {
          setVideo(data)
        }
      } catch (err) {
        if (!cancelled) {
          if (err?.response?.data?.error === 'hidden_by_viewer') {
            setHiddenByViewer(true)
          } else {
            toastError('Failed to load video. Does this video exist?')
            setError('This video is unavailable right now.')
          }
          toastError('This video is unavailable right now.')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [videoId, reloadCount, toastError])

  async function handleUnhide() {
    try {
      await unhideVideo(videoId)
      setReloadCount((count) => count + 1)
    } catch {
      // Leave the hidden notice in place; the user can retry.
    }
  }


  useEffect(() => {
    let cancelled = false

    async function loadPlaylist() {
      if (!playlistId) {
        setPlaylist(null)
        return
      }
      try {
        const data = await getPlaylist(playlistId)
        if (!cancelled) {
          setPlaylist(data)
        }
      } catch {
        if (!cancelled) {
          setPlaylist(null)
        }
      }
    }

    loadPlaylist()

    return () => {
      cancelled = true
    }
  }, [playlistId])

  const canEditPlaylist = Boolean(playlist)
    && (playlist.viewerPermission === 'owner' || playlist.viewerPermission === 'edit')

  function handleReport() {
    navigate('/reports/new', {
      state: {
        reportType: 'video',
        videoId: video.id,
        playlistId: playlist?.id,
        link: window.location.href,
      },
    })
  }

  async function handleRemoveFromPlaylist() {
    try {
      await removePlaylistItem(playlist.id, video.id)
    } catch {
      toastError('Failed to remove from playlist.')
      return
    }
    const currentIndex = playlist.items.findIndex((item) => item.videoId === videoId)
    const nextItem = currentIndex === -1 ? null : playlist.items[currentIndex + 1]
    setPlaylist((prev) => ({
      ...prev,
      itemCount: prev.itemCount - 1,
      items: prev.items.filter((item) => item.id !== video.id),
    }))
    navigate(nextItem ? `/video?v=${nextItem.videoId}&list=${playlist.id}` : '/')
  }

  return (
    <section className="video-page" data-from-random={cameFromRandom || undefined}>
      {error && <p className="video-page-error">{error}</p>}
      {hiddenByViewer && (
        <div className="video-page-hidden-notice">
          <p>You&apos;ve hidden this video.</p>
          <button type="button" onClick={handleUnhide}>Unhide</button>
        </div>
      )}
      {!loading && !error && !hiddenByViewer && video && (
        <div className="video-page-layout">
          <div className="video-page-main">
            <VideoPlayer
              video={video}
              onRemoveFromPlaylist={canEditPlaylist ? handleRemoveFromPlaylist : undefined}
              onReport={user ? handleReport : undefined}
            />
            <VideoComments video={video} />
          </div>
          {playlist ? (
            <PlaylistQueue playlist={playlist} currentVideoId={videoId} />
          ) : (
            <VideoSuggested video={video} />
          )}
        </div>
      )}
    </section>
  )
}

export default VideoPage
