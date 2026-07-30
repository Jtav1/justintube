import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { useTheme } from '../context/useTheme.js'
import TopBar from '../components/TopBar.jsx'
import Sidebar from '../components/Sidebar.jsx'
import './AppLayout.css'

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
  const collapsedByDefault = COLLAPSED_BY_DEFAULT_ROUTES.includes(location.pathname)
  const [collapsed, setCollapsed] = useState(() => collapsedByDefault || readStoredCollapsed())

  // Only re-run when switching in/out of a collapsed-by-default route -
  // manual toggles while staying on the same route shouldn't be undone.
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

  return (
    <div className="app-layout">
      <TopBar
        onToggleSidebar={toggleSidebar}
        backgroundUrl={theme?.images?.headerBackgroundUrl}
      />
      <div className="app-layout-body">
        <Sidebar
          collapsed={collapsed}
          backgroundUrl={theme?.images?.sidebarBackgroundUrl}
        />
        <main className="app-layout-content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

export default AppLayout
