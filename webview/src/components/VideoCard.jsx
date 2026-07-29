import { ImageOff } from 'lucide-react'
import { formatDuration, formatRelativeDate, formatViewCount } from '../lib/format.js'
import apiClient from '../api/client.js'
import './VideoCard.css'

function VideoCard({ video }) {
  const uploaderName = video.uploader?.displayName || video.uploader?.username
  const thumbnailUrl = video.thumbnailUrl
    ? `${apiClient.defaults.baseURL}${video.thumbnailUrl}`
    : null

  return (
    <article className="video-card">
      <div className="video-card-thumb">
        {thumbnailUrl ? (
          <img src={thumbnailUrl} alt="" loading="lazy" />
        ) : (
          <div className="video-card-thumb-placeholder">
            <ImageOff size={28} />
          </div>
        )}
        {video.durationSeconds != null && (
          <span className="video-card-duration">{formatDuration(video.durationSeconds)}</span>
        )}
      </div>
      <h3 className="video-card-title">{video.title}</h3>
      <p className="video-card-meta">{uploaderName}</p>
      <p className="video-card-meta">
        {formatViewCount(video.viewCount)} &middot; {formatRelativeDate(video.createdAt)}
      </p>
    </article>
  )
}

export default VideoCard
