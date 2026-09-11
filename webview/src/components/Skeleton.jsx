import './Skeleton.css'

/**
 * Reusable shimmering placeholder block. Sized entirely by the caller via
 * `className`/`style` - this component only supplies the shimmer visual.
 * @param {{ className?: string, style?: object }} props
 */
export function Skeleton({ className = '', style }) {
  return <div className={`skeleton ${className}`} style={style} />
}

/**
 * Placeholder mirroring VideoCard's DOM shape (thumb + title/meta lines), so
 * it drops into the same grid/rail layouts VideoCard renders into without
 * needing new layout rules.
 * @param {{ orientation?: 'vertical'|'horizontal' }} props
 */
export function VideoCardSkeleton({ orientation = 'vertical' }) {
  return (
    <div className={`video-card-skeleton video-card-skeleton-${orientation}`}>
      <Skeleton className="video-card-skeleton-thumb" />
      <div className="video-card-skeleton-text">
        <Skeleton className="video-card-skeleton-title" />
        <Skeleton className="video-card-skeleton-meta" />
        <Skeleton className="video-card-skeleton-meta video-card-skeleton-meta-short" />
      </div>
    </div>
  )
}
