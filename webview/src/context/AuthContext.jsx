import { useEffect, useState } from 'react'
import * as authApi from '../api/auth.js'
import { readLastLogIn, writeLastLogIn } from '../lib/last-login.js'
import { AuthContext } from './auth-context.js'
import { useTheme } from './useTheme.js'

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  // The login *before* the current session's - read from browser storage
  // rather than `user.lastLogIn`, which the server bumps to "now" on every
  // fresh login. Only a fresh login/register moves this forward (see below);
  // restoring an existing session on page load leaves it untouched.
  const [previousLogIn, setPreviousLogIn] = useState(null)
  const { refreshThemes } = useTheme()

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      await authApi.fetchCsrfToken()
      const currentUser = await authApi.getCurrentUser()
      if (!cancelled) {
        setUser(currentUser)
        setPreviousLogIn(readLastLogIn())
        setLoading(false)
      }
    }

    bootstrap()

    return () => {
      cancelled = true
    }
  }, [])

  async function login(username, password) {
    const loggedInUser = await authApi.login(username, password)
    setPreviousLogIn(readLastLogIn())
    writeLastLogIn(loggedInUser.lastLogIn)
    setUser(loggedInUser)
    await refreshThemes()
    return loggedInUser
  }

  async function register(username, email, password) {
    const registeredUser = await authApi.register(username, email, password)
    setPreviousLogIn(readLastLogIn())
    writeLastLogIn(registeredUser.lastLogIn)
    setUser(registeredUser)
    await refreshThemes()
    return registeredUser
  }

  async function logout() {
    await authApi.logout()
    setUser(null)
  }

  /**
   * Re-fetches the current session's user, syncing global state (e.g. after
   * changing username/email elsewhere in the app).
   * @returns {Promise<object|null>}
   */
  async function refreshUser() {
    const currentUser = await authApi.getCurrentUser()
    setUser(currentUser)
    return currentUser
  }

  return (
    <AuthContext.Provider value={{ user, loading, previousLogIn, login, register, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  )
}
