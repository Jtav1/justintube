import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { searchAdvanced } from '../api/search.js'
import { useToast } from '../context/useToast.js'
import VideoCard from '../components/VideoCard.jsx'
import PlaylistCard from '../components/PlaylistCard.jsx'
import UserCard from '../components/UserCard.jsx'
import './SearchResults.css'

function SearchResults() {
  const { error: toastError } = useToast()
  const [searchParams] = useSearchParams()
  const q = searchParams.get('q') ?? ''

  const [videos, setVideos] = useState([])
  const [playlists, setPlaylists] = useState([])
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!q.trim()) {
      return undefined
    }

    let cancelled = false

    async function load() {
      setLoading(true)
      try {
        const data = await searchAdvanced(q)
        if (!cancelled) {
          setVideos(data.videos)
          setPlaylists(data.playlists)
          setUsers(data.users)
        }
      } catch {
        if (!cancelled) {
          toastError('Failed to load search results.')
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
  }, [q, toastError])

  if (!q.trim()) {
    return (
      <section className="search-results">
        <p className="search-results-empty">Enter a search term above to get started.</p>
      </section>
    )
  }

  return (
    <section className="search-results">
      <h1 className="search-results-title">Search results for &quot;{q}&quot;</h1>

      <div className="search-results-section">
        {!loading && videos.length === 0 && playlists.length === 0 && (
          <p className="search-results-empty">No videos or playlists found.</p>
        )}
        <div className="search-results-grid">
          {videos.map((video) => (
            <VideoCard key={`video-${video.id}`} video={video} showReactionScore={false} />
          ))}
          {playlists.map((playlist) => (
            <PlaylistCard key={`playlist-${playlist.id}`} playlist={playlist} />
          ))}
        </div>
      </div>

      <div className="search-results-section">
        <h2 className="search-results-section-title">Users</h2>
        {!loading && users.length === 0 && (
          <p className="search-results-empty">No matching users.</p>
        )}
        <div className="search-results-users-list">
          {users.map((user) => (
            <UserCard key={`user-${user.id}`} user={user} />
          ))}
        </div>
      </div>
    </section>
  )
}

export default SearchResults
