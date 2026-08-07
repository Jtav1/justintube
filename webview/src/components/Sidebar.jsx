import { NavLink, useLocation } from 'react-router-dom'
import { Home, User, ListVideo, ThumbsUp, History, Star, Users, UsersRound, UserCheck, ShieldCheck, MessageSquareWarning, Braces } from 'lucide-react'
import { useAuth } from '../context/useAuth.js'
import apiClient from '../api/client.js'
import packageJson from '../../package.json'
import './Sidebar.css'

const REPO_URL = 'https://github.com/Jtav1/justintube/'

// lucide-react dropped brand/logo icons (no "Github" export) - inline the
// mark so this pairs visually with the lucide "Braces" icon next to it.
function GithubIcon({ size = 20, title }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1.17-.02-2.12-3.2.7-3.87-1.36-3.87-1.36-.53-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.05 11.05 0 0 1 5.79 0c2.2-1.49 3.18-1.18 3.18-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.69 5.4-5.25 5.68.41.36.78 1.07.78 2.15 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  )
}

function Sidebar({ collapsed, backgroundUrl, onNavigate }) {
  const { user } = useAuth()
  const location = useLocation()

  const ownProfilePath = user ? `/users/${user.username}` : null
  // Own-profile paths (e.g. /users/:me or /users/:me/playlists) should only
  // light up "My Profile", not "Users" - even though both are under /users.
  const isOwnProfilePath = Boolean(
    ownProfilePath
    && (location.pathname === ownProfilePath || location.pathname.startsWith(`${ownProfilePath}/`)),
  )
  const isOnSubscriptionsPath =
    location.pathname === '/subscriptions' || location.pathname.startsWith('/subscriptions/')

  const navItems = [
    { key: 'home', label: 'Home', icon: Home, to: '/', end: true },
    { key: 'profile', label: 'My Profile', icon: User, to: ownProfilePath },
    { key: 'playlists', label: 'Playlists', icon: ListVideo, to: '/playlists' },
    { key: 'liked', label: 'Liked', icon: ThumbsUp, to: user ? `/liked/${user.username}` : null },
    { key: 'history', label: 'History', icon: History, to: user ? '/history' : null },
    { key: 'featured', label: 'Featured', icon: Star, to: '/featured' },
    { key: 'users', label: 'Users', icon: UsersRound, to: '/users', isActiveOverride: (isActive) => isActive && !isOwnProfilePath },
    {
      key: 'subscriptions',
      label: 'Subscriptions',
      icon: Users,
      to: user ? '/subscriptions' : null,
      children: isOnSubscriptionsPath
        ? [
            { key: 'subscriptions-new', label: 'New Content', to: user ? '/subscriptions' : null, end: true },
            { key: 'subscriptions-mine', label: 'My Subscriptions', to: user ? '/subscriptions/mine' : null },
          ]
        : null,
    },
    { key: 'subscribers', label: 'Subscribers', icon: UserCheck, to: user ? '/subscribers' : null },
    { key: 'reports', label: 'Reports', icon: MessageSquareWarning, to: user ? '/reports' : null },
    ...(user?.role === 'admin'
      ? [{ key: 'admin', label: 'Admin Panel', icon: ShieldCheck, to: '/control-panel' }]
      : []),
  ]

  return (
    <div
      className={`sidebar${collapsed ? ' sidebar-collapsed' : ''}`}
      style={backgroundUrl ? { backgroundImage: `url(${backgroundUrl})` } : undefined}
    >
      <nav className="sidebar-nav-wrap">
      <ul className="sidebar-nav">
        {navItems.map(({ key, label, icon: Icon, to, end, isActiveOverride, children }) => (
          <li key={key}>
            {to ? (
              <NavLink
                to={to}
                end={Boolean(end)}
                className={({ isActive }) => {
                  const active = isActiveOverride ? isActiveOverride(isActive) : isActive
                  return `sidebar-item${active ? ' sidebar-item-active' : ''}`
                }}
                onClick={onNavigate}
              >
                <Icon size={20} />
                <span className="sidebar-label">{label}</span>
              </NavLink>
            ) : (
              <span
                className="sidebar-item sidebar-item-placeholder"
                aria-disabled="true"
                tabIndex={-1}
              >
                <Icon size={20} />
                <span className="sidebar-label">{label}</span>
              </span>
            )}
            {children && (
              <ul className="sidebar-subnav">
                {children.map((child) => (
                  <li key={child.key}>
                    {child.to ? (
                      <NavLink
                        to={child.to}
                        end={Boolean(child.end)}
                        className={({ isActive }) =>
                          `sidebar-item sidebar-subitem${isActive ? ' sidebar-item-active' : ''}`
                        }
                        onClick={onNavigate}
                      >
                        <span className="sidebar-label">{child.label}</span>
                      </NavLink>
                    ) : (
                      <span
                        className="sidebar-item sidebar-subitem sidebar-item-placeholder"
                        aria-disabled="true"
                        tabIndex={-1}
                      >
                        <span className="sidebar-label">{child.label}</span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      </nav>
      <footer className="sidebar-footer">
        <hr className="sidebar-footer-divider" />
        <div className="sidebar-footer-row">
          <span className="sidebar-footer-text">Justintube v1.0-alpha</span>
        </div>
        <div className="sidebar-footer-row">
          <div className="sidebar-footer-links">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="sidebar-footer-link"
              aria-label="Code Repository"
              title="Code Repository"
            >
              <GithubIcon size={18} title="Code Repository" />
            </a>
            <a
              href={`${apiClient.defaults.baseURL}/docs`}
              target="_blank"
              rel="noopener noreferrer"
              className="sidebar-footer-link"
              aria-label="API Docs"
              title="API Docs"
            >
              <Braces size={18} aria-label="API Docs" />
            </a>
          </div>
        </div>
        <div className="sidebar-footer-row">
          <span className="sidebar-footer-text">©2026 @jtav1</span>
        </div>
      </footer>
    </div>
  )
}

export default Sidebar
