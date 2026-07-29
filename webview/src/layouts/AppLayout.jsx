import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { useTheme } from '../context/useTheme.js'
import TopBar from '../components/TopBar.jsx'
import Sidebar from '../components/Sidebar.jsx'
import './AppLayout.css'

const SIDEBAR_COLLAPSED_KEY = 'jt.sidebarCollapsed'

function readStoredCollapsed() {
  return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
}

function AppLayout() {
  const { theme } = useTheme()
  const [collapsed, setCollapsed] = useState(readStoredCollapsed)

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed))
  }, [collapsed])

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
