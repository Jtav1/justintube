import { Link } from 'react-router-dom'
import { Radio, VideoOff } from 'lucide-react'
import { formatViewerCount } from '../lib/format.js'
import './LiveStreamCard.css'

/**
 * Display card for a currently-live stream, rendered alongside VideoCard in
 * listings. No HLS preview/thumbnail exists yet, so the thumbnail area
 * always shows a placeholder for now.
 */
function LiveStreamCard({ livestream, orientation = 'vertical' }) {
  const streamerName = livestream.streamer?.displayName || livestream.streamer?.username
  const streamPath = `/live/${livestream.id}`

  return (
    <article className={`livestream-card livestream-card-${orientation}`}>
      <Link to={streamPath} className="livestream-card-thumb">
        <div className="livestream-card-thumb-placeholder">
          <VideoOff size={28} />
        </div>
        <span className="livestream-card-badge">
          <Radio size={12} />
          LIVE
        </span>
      </Link>
      <div className="livestream-card-body">
        <div className="livestream-card-text">
          <h3 className="livestream-card-title">
            <Link to={streamPath}>{livestream.title || 'Untitled stream'}</Link>
          </h3>
          <p className="livestream-card-meta">
            <Link to={streamPath}>{streamerName}</Link>
          </p>
          <p className="livestream-card-meta livestream-card-viewers">
            {formatViewerCount(livestream.viewerCount)}
          </p>
        </div>
      </div>
    </article>
  )
}

export default LiveStreamCard
