import './RouteLoadingFallback.css'

/**
 * Suspense fallback shown while a lazy-loaded route's JS chunk is
 * downloading. Intentionally content-free (not a skeleton) - this only
 * covers a JS-chunk fetch, not page data loading.
 */
function RouteLoadingFallback() {
  return (
    <div className="route-loading-fallback">
      <div className="route-loading-spinner" />
    </div>
  )
}

export default RouteLoadingFallback
