import { useEffect, useState } from 'react'

export const MOBILE_MAX_WIDTH_PX = 640
const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_MAX_WIDTH_PX}px)`

/**
 * Tracks whether the viewport currently matches the mobile breakpoint.
 *
 * @returns {boolean} True when the viewport is at or below the mobile breakpoint.
 */
export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia(MOBILE_MEDIA_QUERY).matches,
  )

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_MEDIA_QUERY)
    function handleChange(event) {
      setIsMobile(event.matches)
    }
    mql.addEventListener('change', handleChange)
    return () => mql.removeEventListener('change', handleChange)
  }, [])

  return isMobile
}
