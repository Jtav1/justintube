import { useEffect, useState } from 'react'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import { getSubscriptionFeed } from '../api/videos.js'
import VideoCard from '../components/VideoCard.jsx'
import './VideoListing.css'

function UserSubscriptions() {
  const { user, loading: authLoading } = useAuth()
  const { error: toastError } = useToast()
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) {
      return undefined
    }

    let cancelled = false

    async function load() {
      setLoading(true)
      try {
        const data = await getSubscriptionFeed()
        if (!cancelled) {
          setItems(data.items)
        }
      } catch {
        if (!cancelled) {
          toastError('Failed to load your subscription feed.')
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
  }, [user, toastError])

  if (authLoading) {
    return null
  }

  if (!user) {
    return (
      <section className="video-listing">
        <p className="video-listing-empty">Log in to see new content from your subscriptions.</p>
      </section>
    )
  }

  return (
    <section className="video-listing">
      {!loading && items.length === 0 && (
        <p className="video-listing-empty">
          No new videos yet. Subscribe to some channels to see their uploads here.
        </p>
      )}

      <div className="video-listing-section">
        <div className="video-listing-grid">
          {items.map((video) => (
            <VideoCard key={video.id} video={video} />
          ))}
        </div>
      </div>
    </section>
  )
}

export default UserSubscriptions
