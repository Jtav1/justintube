import { Check } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useTheme } from '../context/useTheme.js'
import { useAuth } from '../context/useAuth.js'
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
  const scrollable = themes.length > 2

  return (
    <div className="theme-selector">
      <div className={`theme-selector-list${scrollable ? ' theme-selector-scrollable' : ''}`}>
        {themes.map((item) => (
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
      {user?.role === 'admin' && (
        <Link to="/control-panel/themes/new" className="theme-selector-edit-link">
          Manage Themes
        </Link>
      )}
    </div>
  )
}

export default ThemeSelector
