import { Check } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useTheme } from '../context/useTheme.js'
import { useAuth } from '../context/useAuth.js'
import { PUBLIC_THEME_OWNER } from '../api/themes.js'
import './ThemeSelector.css'

function ThemeSwatches({ colors }) {
  return (
    <div className="theme-selector-swatches">
      <span
        className="theme-selector-swatch"
        style={{ backgroundColor: `#${colors.color2}`, borderColor: `#${colors.color1}` }}
      />
      <span
        className="theme-selector-swatch"
        style={{ backgroundColor: `#${colors.color3}`, borderColor: `#${colors.color1}` }}
      />
      <span
        className="theme-selector-swatch"
        style={{ backgroundColor: `#${colors.color4}`, borderColor: `#${colors.color1}` }}
      />
      <span
        className="theme-selector-swatch"
        style={{ backgroundColor: `#${colors.color5}`, borderColor: `#${colors.color1}` }}
      />
    </div>
  )
}

function ThemeSelector() {
  const { theme, themes, selectTheme } = useTheme()
  const { user } = useAuth()
  // GET /themes returns every theme (including other users' private ones)
  // to an admin viewer, so admins get the same public-plus-own filtering
  // here as everyone else - "visible only to the creator/editor" applies to
  // this selector regardless of role. The unfiltered admin list is what the
  // Admin Panel's theme management view is for.
  const selectableThemes = themes.filter(
    (item) => item.themeOwner === PUBLIC_THEME_OWNER || (user && item.themeOwner === String(user.id)),
  )
  const scrollable = selectableThemes.length > 2

  return (
    <div className="theme-selector">
      <div className={`theme-selector-list${scrollable ? ' theme-selector-scrollable' : ''}`}>
        {selectableThemes.map((item) => (
          <button
            type="button"
            className="theme-selector-row"
            key={item.id}
            onClick={() => selectTheme(item.id)}
          >
            <span className="theme-selector-name">{item.name}</span>
            <ThemeSwatches colors={item.colors} />
            <span className="theme-selector-check">
              {theme && theme.id === item.id && <Check size={16} />}
            </span>
          </button>
        ))}
      </div>
      {user && (
        <Link to="/settings/themes" className="theme-selector-edit-link">
          My Themes
        </Link>
      )}
      {user?.role === 'admin' && (
        <Link to="/control-panel" className="theme-selector-edit-link">
          Manage Themes
        </Link>
      )}
    </div>
  )
}

export default ThemeSelector
