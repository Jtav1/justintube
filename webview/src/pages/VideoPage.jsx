import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { getVideo, unhideVideo } from '../api/videos.js'
import { getPlaylist, removePlaylistItem } from '../api/playlists.js'
import { readAutoplayEnabled, writeAutoplayEnabled } from '../lib/autoplay.js'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import { useIsMobile } from '../lib/viewport.js'
import VideoPlayer from '../components/VideoPlayer.jsx'
import VideoComments from '../components/VideoComments.jsx'
import VideoSuggested from '../components/VideoSuggested.jsx'
import PlaylistQueue from '../components/PlaylistQueue.jsx'
import './VideoPage.css'

function VideoPage() {
  const { user } = useAuth()
  const { error: toastError } = useToast()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const [searchParams] = useSearchParams()
  const videoId = searchParams.get('v')
  const playlistId = searchParams.get('list')
  // Set by TopBar's Random Video button (`?random=1`) so this page knows the
  // viewer arrived via shuffle - forces autoplay on (see below).
  const cameFromRandom = searchParams.get('random') === '1'
  // Set by handleAutoplayNext (`?autoplay=1`) so this specific page load
  // knows it was reached by the autoplay countdown, not a manual click -
  // told to VideoPlayer, which waits a beat then starts playback itself.
  const autoplayOnLoad = searchParams.get('autoplay') === '1'

  const [video, setVideo] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [hiddenByViewer, setHiddenByViewer] = useState(false)
  const [playlist, setPlaylist] = useState(null)
  const [reloadCount, setReloadCount] = useState(0)
  const [autoplayEnabled, setAutoplayEnabled] = useState(() => readAutoplayEnabled())
  // Mirrors VideoSuggested's loaded suggestions so autoplay-next can pick a
  // random one without VideoSuggested needing to own navigation itself.
  const [suggestions, setSuggestions] = useState([])
  // Expands the player to the full width of the page (between the sidebar
  // and the screen edge) by stacking the suggested/queue rail below it
  // instead of beside it - toggled by VideoPlayer's overlay button.
  const [expanded, setExpanded] = useState(false)

  // Arriving via the Random Video button forces autoplay on going forward
  // (it's a persisted, browser-wide preference, not just for this view).
  // Adjusted during render (not an effect), same pattern as TopBar's
  // syncedSearchKey - `videoId` guards it to firing once per random arrival
  // rather than on every render.
  const [lastForcedRandomVideoId, setLastForcedRandomVideoId] = useState(null)
  if (cameFromRandom && videoId !== lastForcedRandomVideoId) {
    setLastForcedRandomVideoId(videoId)
    setAutoplayEnabled(true)
  }

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

  // Persists autoplayEnabled to this browser whenever it changes, regardless
  // of whether the change came from the user toggling it or arriving via the
  // Random Video button above.
  useEffect(() => {
    writeAutoplayEnabled(autoplayEnabled)
  }, [autoplayEnabled])

  function handleAutoplayChange(enabled) {
    setAutoplayEnabled(enabled)
  }

  function handleAutoplayNext() {
    if (suggestions.length === 0) {
      return
    }
    const next = suggestions[Math.floor(Math.random() * suggestions.length)]
    // Carries `random=1` forward so the chain of autoplayed videos keeps
    // being treated as "arrived via random" on each hop, and sets
    // `autoplay=1` so the next page starts playback itself instead of
    // waiting on a click. A manual click on a suggestion/search result/etc.
    // is a plain link with neither param, so that kind of navigation
    // intentionally does not carry either forward.
    navigate(`/video?v=${next.videoId}&random=1&autoplay=1`)
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
    <section className="video-page">
      {error && <p className="video-page-error">{error}</p>}
      {hiddenByViewer && (
        <div className="video-page-hidden-notice">
          <p>You&apos;ve hidden this video.</p>
          <button type="button" onClick={handleUnhide}>Unhide</button>
        </div>
      )}
      {!loading && !error && !hiddenByViewer && video && (
        <div className={`video-page-layout${expanded && !isMobile ? ' video-page-layout-expanded' : ''}`}>
          <div className="video-page-main">
            <VideoPlayer
              video={video}
              onRemoveFromPlaylist={canEditPlaylist ? handleRemoveFromPlaylist : undefined}
              onReport={user ? handleReport : undefined}
              autoplayEnabled={!playlist && autoplayEnabled}
              onAutoplayNext={handleAutoplayNext}
              onAutoplayChange={handleAutoplayChange}
              autoplayOnLoad={autoplayOnLoad}
              expanded={expanded && !isMobile}
              onToggleExpand={isMobile ? undefined : () => setExpanded((prev) => !prev)}
            />
            <VideoComments video={video} />
          </div>
          {playlist ? (
            <PlaylistQueue playlist={playlist} currentVideoId={videoId} />
          ) : (
            <VideoSuggested
              video={video}
              autoplayEnabled={autoplayEnabled}
              onAutoplayChange={handleAutoplayChange}
              onSuggestionsChange={setSuggestions}
            />
          )}
        </div>
      )}
    </section>
  )
}

export default VideoPage
