import { NavLink } from 'react-router-dom'
import { Home, User, ListVideo, ThumbsUp, Star, Users, ShieldCheck, MessageSquareWarning } from 'lucide-react'
import { useAuth } from '../context/useAuth.js'
import './Sidebar.css'

function Sidebar({ collapsed, backgroundUrl }) {
  const { user } = useAuth()

  const navItems = [
    { key: 'home', label: 'Home', icon: Home, to: '/' },
    { key: 'profile', label: 'My Profile', icon: User, to: user ? `/users/${user.username}` : '/' },
    { key: 'playlists', label: 'Playlists', icon: ListVideo, to: '/playlists' },
    { key: 'liked', label: 'Liked', icon: ThumbsUp, to: user ? `/liked/${user.username}` : '/'},
    { key: 'featured', label: 'Featured', icon: Star, to: '/featured' },
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
        {navItems.map(({ key, label, icon: Icon, to }) => (
          <li key={key}>
            {to ? (
              <NavLink
                to={to}
                end={to === '/'}
                className={({ isActive }) => `sidebar-item${isActive ? ' sidebar-item-active' : ''}`}
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
