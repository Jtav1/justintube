import { useEffect, useRef } from 'react'

/**
 * Fires `onLoadMore` whenever the returned sentinel ref scrolls into view,
 * as long as `hasMore` is true and `loading` is false. Used to turn a
 * paginated "Load more" button into automatic infinite scroll: render an
 * empty element with this ref near the bottom of the list.
 * @param {{ hasMore: boolean, loading: boolean, onLoadMore: () => void }} options
 * @returns {import('react').RefObject<HTMLElement>} Ref to attach to a sentinel element.
 */
export function useInfiniteScroll({ hasMore, loading, onLoadMore }) {
  const sentinelRef = useRef(null)

  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasMore || loading) {
      return undefined
    }

    // IntersectionObserver invokes the callback once immediately with the
    // sentinel's current intersection state, so a short page (sentinel
    // already in view right after mount, or right after `loading` flips
    // back to false) keeps loading further pages without waiting for an
    // actual scroll event.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          onLoadMore()
        }
      },
      { rootMargin: '600px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, loading, onLoadMore])

  return sentinelRef
}
