import { Link } from 'react-router-dom'
import { Home, User, Star } from 'lucide-react'
import './Sidebar.css'

const NAV_ITEMS = [
  { key: 'home', label: 'Home', icon: Home, to: '/' },
  { key: 'profile', label: 'My Profile', icon: User, to: null },
  { key: 'featured', label: 'Featured', icon: Star, to: null },
]

function Sidebar({ collapsed, backgroundUrl }) {
  return (
    <nav
      className={`sidebar${collapsed ? ' sidebar-collapsed' : ''}`}
      style={backgroundUrl ? { backgroundImage: `url(${backgroundUrl})` } : undefined}
    >
      <ul className="sidebar-nav">
        {NAV_ITEMS.map(({ key, label, icon: Icon, to }) => (
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
