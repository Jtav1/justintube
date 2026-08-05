import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { useTheme } from '../context/useTheme.js'
import apiClient from '../api/client.js'
import { useIsMobile } from '../lib/viewport.js'
import { useDismissablePopover } from '../hooks/useDismissablePopover.js'
import { useRouteAnnouncer } from '../hooks/useRouteAnnouncer.js'
import TopBar from '../components/TopBar.jsx'
import Sidebar from '../components/Sidebar.jsx'
import './AppLayout.css'

/**
 * Resolves a theme image path (as returned under `theme.images`, e.g.
 * `/api/v1/themes/:id/images/view`) into an absolute URL. Returns null when
 * no image is set, matching the API's own null-when-absent contract.
 * @param {string|null|undefined} path Theme image path from the API.
 * @returns {string|null} Absolute URL, or null if no image is set.
 */
function resolveThemeImageUrl(path) {
  return path ? `${apiClient.defaults.baseURL}${path}` : null
}

const SIDEBAR_COLLAPSED_KEY = 'jt.sidebarCollapsed'

// Routes whose default is a collapsed sidebar, overriding the stored
// preference, since they need the extra width (e.g. the video watch page).
const COLLAPSED_BY_DEFAULT_ROUTES = ['/video']

function readStoredCollapsed() {
  return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
}

function AppLayout() {
  const { theme } = useTheme()
  const location = useLocation()
  const isMobile = useIsMobile()
  const mainRef = useRef(null)
  useRouteAnnouncer(mainRef)
  const collapsedByDefault = COLLAPSED_BY_DEFAULT_ROUTES.includes(location.pathname) || isMobile
  const [collapsed, setCollapsed] = useState(() => collapsedByDefault || readStoredCollapsed())

  // Only re-run when switching in/out of a collapsed-by-default route (or
  // crossing the mobile breakpoint) - manual toggles while staying put
  // shouldn't be undone.
  useEffect(() => {
    setCollapsed(collapsedByDefault || readStoredCollapsed())
  }, [collapsedByDefault])

  useEffect(() => {
    if (!collapsedByDefault) {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed))
    }
  }, [collapsed, collapsedByDefault])

  function toggleSidebar() {
    setCollapsed((prev) => !prev)
  }

  function closeSidebar() {
    setCollapsed(true)
  }

  const mobileSidebarOpen = isMobile && !collapsed
  useDismissablePopover(mobileSidebarOpen, closeSidebar, null)

  const viewBackgroundUrl = resolveThemeImageUrl(theme?.images?.viewBackgroundUrl)

  return (
    <div className="app-layout">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <TopBar
        onToggleSidebar={toggleSidebar}
        backgroundUrl={resolveThemeImageUrl(theme?.images?.headerBackgroundUrl)}
      />
      <div className="app-layout-body">
        <Sidebar
          collapsed={collapsed}
          backgroundUrl={resolveThemeImageUrl(theme?.images?.sidebarBackgroundUrl)}
          onNavigate={isMobile ? closeSidebar : undefined}
        />
        {mobileSidebarOpen && (
          <div
            className="app-layout-backdrop"
            role="button"
            tabIndex={-1}
            aria-label="Close sidebar"
            onClick={closeSidebar}
          />
        )}
        <main
          id="main-content"
          ref={mainRef}
          tabIndex={-1}
          className="app-layout-content"
          style={viewBackgroundUrl ? { backgroundImage: `url(${viewBackgroundUrl})` } : undefined}
        >
          <Outlet />
        </main>
      </div>
    </div>
  )
}

export default AppLayout
