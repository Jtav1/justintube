import { useEffect, useState } from 'react'
import { getThemes, selectMyTheme } from '../api/themes.js'
import { ThemeContext } from './theme-context.js'

const CACHED_THEME_ID_KEY = 'jt.themeId'

function readCachedThemeId() {
  const raw = localStorage.getItem(CACHED_THEME_ID_KEY)
  return raw === null ? null : Number(raw)
}

function writeCachedThemeId(themeId) {
  if (themeId == null) {
    localStorage.removeItem(CACHED_THEME_ID_KEY)
    return
  }
  localStorage.setItem(CACHED_THEME_ID_KEY, String(themeId))
}

function hexToRgba(hex, alpha) {
  const value = parseInt(hex, 16)
  const r = (value >> 16) & 0xff
  const g = (value >> 8) & 0xff
  const b = value & 0xff
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function applyThemeColors(theme) {
  const root = document.documentElement
  if (!theme) {
    return
  }

  const { color1, color2, color3, color4, color5 } = theme.colors
  root.style.setProperty('--border', `#${color1}`)
  root.style.setProperty('--bg', `#${color2}`)
  root.style.setProperty('--text', `#${color3}`)
  root.style.setProperty('--text-h', `#${color4}`)
  root.style.setProperty('--accent', `#${color5}`)
  root.style.setProperty('--accent-bg', hexToRgba(color5, 0.1))
  root.style.setProperty('--accent-border', hexToRgba(color5, 0.5))
  root.style.setProperty('--code-bg', hexToRgba(color1, 0.08))
  root.style.setProperty('--social-bg', hexToRgba(color1, 0.05))
}

function pickActiveTheme(items, selectedThemeId) {
  if (selectedThemeId != null) {
    const selected = items.find((item) => item.id === selectedThemeId)
    if (selected) {
      return selected
    }
  }
  return items.find((item) => item.isDefault) || null
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(null)
  const [themes, setThemes] = useState([])
  const [loading, setLoading] = useState(true)

  // `selectedThemeId` reflects the signed-in user's server-side preference
  // (null once logged out). The browser-cached id is only used as a fallback
  // so the last-picked theme keeps showing after logout, on this browser.
  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      try {
        const { items, selectedThemeId } = await getThemes()
        const active = pickActiveTheme(items, selectedThemeId ?? readCachedThemeId())
        if (!cancelled) {
          setThemes(items)
          setTheme(active)
          applyThemeColors(active)
        }
      } catch (err) {
        console.error('Failed to load theme:', err)
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    bootstrap()

    return () => {
      cancelled = true
    }
  }, [])

  // Re-syncs the cached theme id with the signed-in user's server-side
  // selection; called after login so the cache reflects that account's theme.
  async function refreshThemes() {
    try {
      const { items, selectedThemeId } = await getThemes()
      const active = pickActiveTheme(items, selectedThemeId ?? readCachedThemeId())
      setThemes(items)
      setTheme(active)
      applyThemeColors(active)
      writeCachedThemeId(active ? active.id : null)
    } catch (err) {
      console.error('Failed to refresh themes:', err)
    }
  }

  async function selectTheme(themeId) {
    const target = themes.find((item) => item.id === themeId)
    if (!target) {
      return
    }

    setTheme(target)
    applyThemeColors(target)
    writeCachedThemeId(target.id)

    try {
      await selectMyTheme(themeId)
    } catch (err) {
      if (err.response && err.response.status === 401) {
        return
      }
      console.error('Failed to save theme selection:', err)
    }
  }

  return (
    <ThemeContext.Provider value={{ theme, themes, loading, selectTheme, refreshThemes }}>
      {children}
    </ThemeContext.Provider>
  )
}
