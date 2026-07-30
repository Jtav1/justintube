import { ImageOff } from 'lucide-react'
import apiClient from '../api/client.js'
import './PlaylistCard.css'

function PlaylistCard({ playlist }) {
  const thumbnails = (playlist.thumbnails ?? []).slice(0, 3)
  const ownerName = playlist.owner?.displayName || playlist.owner?.username

  return (
    <article className="playlist-card">
      <div className="playlist-card-thumb">
        {thumbnails.length > 0 ? (
          thumbnails.map((url, i) => (
            <img
              key={url}
              src={`${apiClient.defaults.baseURL}${url}`}
              alt=""
              loading="lazy"
              className={`playlist-card-thumb-layer playlist-card-thumb-layer-${i}`}
            />
          ))
        ) : (
          <div className="playlist-card-thumb-placeholder">
            <ImageOff size={28} />
          </div>
        )}
        <span className="playlist-card-count-badge">{playlist.itemCount}</span>
      </div>
      <div className="playlist-card-body">
        <h3 className="playlist-card-title">{playlist.name}</h3>
        {ownerName && <p className="playlist-card-meta">{ownerName}</p>}
        <p className="playlist-card-meta">
          {playlist.itemCount} {playlist.itemCount === 1 ? 'video' : 'videos'}
        </p>
      </div>
    </article>
  )
}

export default PlaylistCard
