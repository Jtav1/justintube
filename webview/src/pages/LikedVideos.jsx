import { useEffect, useState } from 'react'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import { getMyLikes } from '../api/videos.js'
import { getMyLikesPlaylist } from '../api/playlists.js'
import VideoCard from '../components/VideoCard.jsx'
import PlaylistCard from '../components/PlaylistCard.jsx'
import './VideoListing.css'

const PAGE_LIMIT = 24

function LikedVideos() {
  const { user, loading: authLoading } = useAuth()
  const { error: toastError } = useToast()
  const [items, setItems] = useState([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [likesPlaylist, setLikesPlaylist] = useState(null)

  useEffect(() => {
    if (!user) {
      return undefined
    }

    let cancelled = false

    async function load() {
      setLoading(true)
      try {
        const data = await getMyLikes({ page: 1, limit: PAGE_LIMIT })
        if (!cancelled) {
          setItems(data.items)
          setPage(data.page)
          setTotalPages(data.totalPages)
        }
      } catch {
        if (!cancelled) {
          toastError('Failed to load your liked videos.')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    async function loadPlaylist() {
      try {
        const playlist = await getMyLikesPlaylist()
        if (!cancelled) {
          setLikesPlaylist(playlist)
        }
      } catch {
        if (!cancelled) {
          setLikesPlaylist(null)
        }
      }
    }

    load()
    loadPlaylist()

    return () => {
      cancelled = true
    }
  }, [user, toastError])

  async function handleLoadMore() {
    if (loadingMore) {
      return
    }
    setLoadingMore(true)
    try {
      const data = await getMyLikes({ page: page + 1, limit: PAGE_LIMIT })
      setItems((prev) => [...prev, ...data.items])
      setPage(data.page)
      setTotalPages(data.totalPages)
    } catch {
      toastError('Failed to load more videos.')
    } finally {
      setLoadingMore(false)
    }
  }

  if (authLoading) {
    return null
  }

  if (!user) {
    return (
      <section className="video-listing">
        <p className="video-listing-empty">Log in to view your liked videos.</p>
      </section>
    )
  }

  return (
    <section className="video-listing">
      {!loading && items.length === 0 && (
        <p className="video-listing-empty">You haven't liked any videos yet.</p>
      )}

      <div className="video-listing-section">
        <h2 className="video-listing-section-title">Liked Videos</h2>
        <div className="video-listing-grid">
          {likesPlaylist && <PlaylistCard key={`playlist-${likesPlaylist.id}`} playlist={likesPlaylist} />}
          {items.map((video) => (
            <VideoCard key={video.id} video={video} />
          ))}
        </div>
        {page < totalPages && (
          <button
            type="button"
            className="video-listing-load-more"
            disabled={loadingMore}
            onClick={handleLoadMore}
          >
            Load more
          </button>
        )}
      </div>
    </section>
  )
}

export default LikedVideos
