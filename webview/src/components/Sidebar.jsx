import { NavLink, useLocation } from 'react-router-dom'
import { Home, User, ListVideo, ThumbsUp, Star, Users, UsersRound, ShieldCheck, MessageSquareWarning } from 'lucide-react'
import { useAuth } from '../context/useAuth.js'
import './Sidebar.css'

function Sidebar({ collapsed, backgroundUrl }) {
  const { user } = useAuth()
  const location = useLocation()

  const ownProfilePath = user ? `/users/${user.username}` : null
  // Own-profile paths (e.g. /users/:me or /users/:me/playlists) should only
  // light up "My Profile", not "Users" - even though both are under /users.
  const isOwnProfilePath = Boolean(
    ownProfilePath
    && (location.pathname === ownProfilePath || location.pathname.startsWith(`${ownProfilePath}/`)),
  )

  const navItems = [
    { key: 'home', label: 'Home', icon: Home, to: '/', end: true },
    { key: 'profile', label: 'My Profile', icon: User, to: ownProfilePath || '/' },
    { key: 'playlists', label: 'Playlists', icon: ListVideo, to: '/playlists' },
    { key: 'liked', label: 'Liked', icon: ThumbsUp, to: user ? `/liked/${user.username}` : '/'},
    { key: 'featured', label: 'Featured', icon: Star, to: '/featured' },
    { key: 'users', label: 'Users', icon: UsersRound, to: '/users', isActiveOverride: (isActive) => isActive && !isOwnProfilePath },
    { key: 'subscriptions', label: 'Subscriptions', icon: Users, to: null },
    ...(user?.role === 'admin'
      ? [{ key: 'admin', label: 'Admin Panel', icon: ShieldCheck, to: null }]
      : []),
    ...((user?.role === 'moderator' || user?.role === 'admin')
      ? [{ key: 'reports', label: "Reports", icon: MessageSquareWarning, to: null }]
      : []),
  ]

  return (
    <nav
      className={`sidebar${collapsed ? ' sidebar-collapsed' : ''}`}
      style={backgroundUrl ? { backgroundImage: `url(${backgroundUrl})` } : undefined}
    >
      <ul className="sidebar-nav">
        {navItems.map(({ key, label, icon: Icon, to, end, isActiveOverride }) => (
          <li key={key}>
            {to ? (
              <NavLink
                to={to}
                end={Boolean(end)}
                className={({ isActive }) => {
                  const active = isActiveOverride ? isActiveOverride(isActive) : isActive
                  return `sidebar-item${active ? ' sidebar-item-active' : ''}`
                }}
              >
                <Icon size={20} />
                <span className="sidebar-label">{label}</span>
              </NavLink>
            ) : (
              <span className="sidebar-item sidebar-item-placeholder">
                <Icon size={20} />
                <span className="sidebar-label">{label}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </nav>
  )
}

export default Sidebar
