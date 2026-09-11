import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { fetchCsrfToken } from '../api/auth.js'
import { useAuth } from '../context/useAuth.js'
import './AuthForm.css'

function errorMessage(err) {
  const code = err.response?.data?.error
  if (code === 'invalid_credentials') {
    return 'Invalid username or password.'
  }
  return 'Something went wrong. Please try again.'
}

function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetchCsrfToken()
  }, [])

  useEffect(() => {
    document.title = 'Log in - Justintube'
  }, [])

  async function handleSubmit(event) {
    event.preventDefault()
    if (submitting) {
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      await login(username, password)
      navigate('/')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section id="auth-center">
      <form className="auth-card" onSubmit={handleSubmit}>
        <h1>Log in</h1>
        <label htmlFor="username">
          Username <span className="required-mark" aria-hidden="true">*</span>
        </label>
        <input
          id="username"
          name="username"
          type="text"
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          aria-describedby={error ? 'login-error' : undefined}
          aria-invalid={error ? 'true' : undefined}
          required
        />
        <label htmlFor="password">
          Password <span className="required-mark" aria-hidden="true">*</span>
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-describedby={error ? 'login-error' : undefined}
          aria-invalid={error ? 'true' : undefined}
          required
        />
        {error && (
          <p id="login-error" className="auth-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="auth-submit" disabled={submitting}>
          Log in
        </button>
        <p className="auth-link">
          <Link to="/forgot-password">Forgot password?</Link>
        </p>
        <p className="auth-link">
          Don't have an account? <Link to="/register">Register</Link>
        </p>
      </form>
    </section>
  )
}

export default LoginPage
