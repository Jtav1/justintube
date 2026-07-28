import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Menu, Palette, Search, UserRound } from 'lucide-react'
import { useAuth } from '../context/useAuth.js'
import apiClient from '../api/client.js'
import ThemeSelector from './ThemeSelector.jsx'
import './TopBar.css'

function TopBar({ onToggleSidebar, backgroundUrl }) {
  const { user, logout } = useAuth()
  const [themeMenuOpen, setThemeMenuOpen] = useState(false)
  const themeMenuRef = useRef(null)

  useEffect(() => {
    if (!themeMenuOpen) {
      return undefined
    }

    function handleClickOutside(event) {
      if (themeMenuRef.current && !themeMenuRef.current.contains(event.target)) {
        setThemeMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [themeMenuOpen])

  const avatarUrl = user
    ? `${apiClient.defaults.baseURL}/api/v1/users/${user.username}/avatar`
    : null

  return (
    <header
      className="topbar"
      style={backgroundUrl ? { backgroundImage: `url(${backgroundUrl})` } : undefined}
    >
      <div className="topbar-left">
        <button
          type="button"
          className="topbar-toggle"
          onClick={onToggleSidebar}
          aria-label="Toggle sidebar"
        >
          <Menu size={20} />
        </button>
        <Link to="/" className="topbar-title">
          Justintube
        </Link>
      </div>
      <div className="topbar-center">
        <form className="topbar-search" onSubmit={(event) => event.preventDefault()}>
          <input
            type="text"
            className="topbar-search-input"
            placeholder="Search"
            aria-label="Search"
          />
          <button type="submit" className="topbar-search-button" aria-label="Search">
            <Search size={18} />
          </button>
        </form>
      </div>
      <div className="topbar-right">
        <div className="topbar-theme" ref={themeMenuRef}>
          <button
            type="button"
            className="topbar-theme-toggle"
            onClick={() => setThemeMenuOpen((open) => !open)}
            aria-label="Select theme"
            aria-haspopup="true"
            aria-expanded={themeMenuOpen}
          >
            <Palette size={20} />
          </button>
          {themeMenuOpen && (
            <div className="topbar-theme-menu" role="menu">
              <ThemeSelector />
            </div>
          )}
        </div>
        {user ? (
          <>
            {user.avatarFilename ? (
              <img className="topbar-avatar" src={avatarUrl} alt="" />
            ) : (
              <span className="topbar-avatar topbar-avatar-placeholder">
                <UserRound size={18} />
              </span>
            )}
            <span className="topbar-username">{user.displayName || user.username}</span>
            <button type="button" className="topbar-logout" onClick={logout}>
              Log out
            </button>
          </>
        ) : (
          <Link to="/login">Log in</Link>
        )}
      </div>
    </header>
  )
}

export default TopBar
