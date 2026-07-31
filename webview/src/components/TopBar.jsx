import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Menu, Palette, Search, UserRound, Video } from 'lucide-react'
import { useAuth } from '../context/useAuth.js'
import apiClient from '../api/client.js'
import SearchAutocomplete from './SearchAutocomplete.jsx'
import ThemeSelector from './ThemeSelector.jsx'
import './TopBar.css'

function TopBar({ onToggleSidebar, backgroundUrl }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [themeMenuOpen, setThemeMenuOpen] = useState(false)
  const themeMenuRef = useRef(null)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userMenuRef = useRef(null)

  // Keeps the search box in sync with the URL only on the results page -
  // elsewhere it's free local state that starts empty on navigation. Adjusted
  // during render (not an effect) per https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes.
  const [syncedSearchKey, setSyncedSearchKey] = useState(null)
  const searchKey = location.pathname === '/search' ? searchParams.get('q') ?? '' : null
  if (searchKey !== null && searchKey !== syncedSearchKey) {
    setSyncedSearchKey(searchKey)
    setQuery(searchKey)
  }

  function handleSearchSubmit(event) {
    event.preventDefault()
    const trimmed = query.trim()
    if (!trimmed) {
      return
    }
    navigate(`/search?q=${encodeURIComponent(trimmed)}`)
  }

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

  useEffect(() => {
    if (!userMenuOpen) {
      return undefined
    }

    function handleClickOutside(event) {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target)) {
        setUserMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [userMenuOpen])

  const avatarUrl = user
    ? `${apiClient.defaults.baseURL}/api/v1/users/${user.username}/avatar`
    : null
  const canUpload = Boolean(
    user && (user.role === 'admin' || (user.uploader && user.emailVerified)),
  )

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
          <svg
            className="topbar-logo"
            width="150"
            height="34"
            viewBox="0 0 180 40"
            xmlns="http://www.w3.org/2000/svg"
            role="img"
            aria-label="Justintube"
          >
            <g fill="none" stroke="#0b3d91" strokeWidth="2" strokeLinejoin="round">
              <rect x="2" y="9" width="30" height="22" rx="5" />
              <path d="M32 16.5 L44 11 V29 L32 23.5 Z" />
            </g>
            <path
              d="M14 14 L24 20 L14 26 Z"
              fill="none"
              stroke="#000"
              strokeWidth="2"
              strokeLinejoin="round"
            />
            <text
              x="52"
              y="27"
              fontFamily="Verdana, Geneva, sans-serif"
              fontSize="19"
              fontWeight="bold"
              fontStyle="normal"
              fill="currentColor"
            >
              Justintube
            </text>
          </svg>
        </Link>
      </div>
      <div className="topbar-center">
        <form className="topbar-search" onSubmit={handleSearchSubmit}>
          <SearchAutocomplete value={query} onChange={setQuery} />
          <button type="submit" className="topbar-search-button" aria-label="Search">
            <Search size={18} />
          </button>
        </form>
      </div>
      <div className="topbar-right">
        {canUpload && (
          <Link to="/upload" className="topbar-upload">
            <Video size={18} />
            <span>Upload</span>
          </Link>
        )}
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
            <div className="topbar-user" ref={userMenuRef}>
              <button
                type="button"
                className="topbar-user-button"
                onClick={() => setUserMenuOpen((open) => !open)}
                aria-haspopup="true"
                aria-expanded={userMenuOpen}
              >
                {user.avatarFilename ? (
                  <img className="topbar-avatar" src={avatarUrl} alt="" />
                ) : (
                  <span className="topbar-avatar topbar-avatar-placeholder">
                    <UserRound size={18} />
                  </span>
                )}
                <span className="topbar-username">{user.displayName || user.username}</span>
              </button>
              {userMenuOpen && (
                <div className="topbar-user-menu" role="menu">
                  <Link
                    to={`/users/${user.username}`}
                    className="topbar-user-menu-item"
                    onClick={() => setUserMenuOpen(false)}
                  >
                    My Profile
                  </Link>
                  <Link
                    to="/settings"
                    className="topbar-user-menu-item"
                    onClick={() => setUserMenuOpen(false)}
                  >
                    Settings
                  </Link>
                </div>
              )}
            </div>
            <button type="button" className="topbar-logout" onClick={logout}>
              Log out
            </button>
          </>
        ) : (
          <Link to="/login" className="topbar-login">
            Log in
          </Link>
        )}
      </div>
    </header>
  )
}

export default TopBar
