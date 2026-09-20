import { useEffect } from 'react'
import { formatDocumentTitle } from '../lib/document-title.js'

/**
 * Sets `document.title` from content the page itself knows about - a video's
 * name rather than the generic label its route would otherwise get.
 *
 * Only for routes listed as page-owned in useRouteAnnouncer: that hook runs from
 * the shared layout and would otherwise overwrite this on every navigation.
 *
 * Beyond the browser tab, this is what Safari hands an AirPlay receiver as the
 * item title, so an Apple TV shows the video's name instead of "Watch".
 *
 * @param {string|null|undefined} title The page-specific title, or null/undefined while it loads.
 * @returns {void}
 */
export function useDocumentTitle(title) {
  useEffect(() => {
    // Skipped entirely while the title is still loading, so the previous title
    // stays up rather than flashing the bare site name for a beat.
    if (title == null || title === '') {
      return
    }
    document.title = formatDocumentTitle(title)
  }, [title])
}
