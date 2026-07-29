import { Link } from 'react-router-dom'
import { Home, User, ListVideo, ThumbsUp, Star, Users, ShieldCheck } from 'lucide-react'
import { useAuth } from '../context/useAuth.js'
import './Sidebar.css'

function Sidebar({ collapsed, backgroundUrl }) {
  const { user } = useAuth()

  const navItems = [
    { key: 'home', label: 'Home', icon: Home, to: '/' },
    { key: 'profile', label: 'My Profile', icon: User, to: user ? `/users/${user.username}` : null },
    { key: 'playlists', label: 'Playlists', icon: ListVideo, to: '/' },
    { key: 'liked', label: 'Liked', icon: ThumbsUp, to: '/' },
    { key: 'featured', label: 'Featured', icon: Star, to: '/' },
    { key: 'subscriptions', label: 'Subscriptions', icon: Users, to: '/' },
    ...(user?.role === 'admin'
      ? [{ key: 'admin', label: 'Admin Panel', icon: ShieldCheck, to: '/' }]
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
              <Link to={to} className="sidebar-item">
                <Icon size={20} />
                <span className="sidebar-label">{label}</span>
              </Link>
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
