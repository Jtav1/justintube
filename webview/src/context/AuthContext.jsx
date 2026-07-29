import { useEffect, useState } from 'react'
import * as authApi from '../api/auth.js'
import { AuthContext } from './auth-context.js'

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      await authApi.fetchCsrfToken()
      const currentUser = await authApi.getCurrentUser()
      if (!cancelled) {
        setUser(currentUser)
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
    setUser(loggedInUser)
    return loggedInUser
  }

  async function register(username, email, password) {
    const registeredUser = await authApi.register(username, email, password)
    setUser(registeredUser)
    return registeredUser
  }

  async function logout() {
    await authApi.logout()
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  )
}
