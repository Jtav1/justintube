import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'

const SITE_NAME = 'Justintube'

// Ordered by specificity (checked top to bottom) since some paths are
// prefixes of others (e.g. /subscriptions vs /subscriptions/mine).
const ROUTE_TITLES = [
  { test: (p) => p === '/', title: 'Home' },
  { test: (p) => p === '/login', title: 'Log in' },
  { test: (p) => p === '/register', title: 'Register' },
  { test: (p) => p === '/verify-email', title: 'Verify email' },
  { test: (p) => p === '/reports', title: 'Reports' },
  { test: (p) => p === '/control-panel', title: 'Admin panel' },
  { test: (p) => p.startsWith('/control-panel/themes'), title: 'Manage themes' },
  { test: (p) => p === '/video', title: 'Watch' },
  { test: (p) => p === '/upload', title: 'Upload' },
  { test: (p) => p.startsWith('/playlists/new') || p.endsWith('/edit'), title: 'Edit playlist' },
  { test: (p) => p === '/playlists', title: 'Playlists' },
  { test: (p) => p.startsWith('/users/') && p.endsWith('/playlists'), title: 'Playlists' },
  { test: (p) => p.startsWith('/users/'), title: 'Profile' },
  { test: (p) => p.startsWith('/liked/'), title: 'Liked videos' },
  { test: (p) => p === '/history', title: 'History' },
  { test: (p) => p === '/featured', title: 'Featured' },
  { test: (p) => p === '/users', title: 'Users' },
  { test: (p) => p === '/search', title: 'Search' },
  { test: (p) => p === '/settings/api-keys', title: 'API Keys' },
  { test: (p) => p === '/settings', title: 'Settings' },
  { test: (p) => p.startsWith('/subscriptions'), title: 'Subscriptions' },
  { test: (p) => p === '/subscribers', title: 'Subscribers' },
  { test: (p) => p === '/notifications', title: 'Notifications' },
]

function titleForPath(pathname) {
  const match = ROUTE_TITLES.find(({ test }) => test(pathname))
  return match ? `${match.title} - ${SITE_NAME}` : SITE_NAME
}

/**
 * Sets `document.title` per route and moves focus to the main content
 * region on navigation, so screen reader/keyboard users get the same "new
 * page" signal SPA routing otherwise swallows (no full page load/title
 * change happens on its own).
 *
 * @param {{ current: HTMLElement|null }} mainRef Ref to the route's main landmark; focus is skipped if not mounted (e.g. standalone auth pages with no shared layout).
 */
export function useRouteAnnouncer(mainRef) {
  const location = useLocation()
  const isFirstRender = useRef(true)

  useEffect(() => {
    document.title = titleForPath(location.pathname)

    // Skip focus-stealing on the very first render - the user's initial
    // focus (e.g. from a direct link/refresh) shouldn't be overridden.
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }

    mainRef?.current?.focus()
  }, [location.pathname, mainRef])
}
