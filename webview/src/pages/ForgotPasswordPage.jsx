import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchCsrfToken, forgotPassword } from '../api/auth.js'
import './AuthForm.css'

function errorMessage() {
  return 'Something went wrong. Please try again.'
}

function ForgotPasswordPage() {
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    document.title = 'Forgot password - Justintube'
  }, [])

  async function handleSubmit(event) {
    event.preventDefault()
    if (submitting) {
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      await fetchCsrfToken()
      await forgotPassword(username, email)
      setSubmitted(true)
    } catch {
      setError(errorMessage())
    } finally {
      setSubmitting(false)
    }
  }

  if (submitted) {
    return (
      <section id="auth-center">
        <div className="auth-card">
          <h1>Forgot password</h1>
          <p>
            If an account matches, we&apos;ve sent a password reset link to that email address.
          </p>
          <p className="auth-link">
            <Link to="/login">Back to log in</Link>
          </p>
        </div>
      </section>
    )
  }

  return (
    <section id="auth-center">
      <form className="auth-card" onSubmit={handleSubmit}>
        <h1>Forgot password</h1>
        <p>Enter your username and email address and we&apos;ll send you a reset link.</p>
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
          aria-describedby={error ? 'forgot-password-error' : undefined}
          aria-invalid={error ? 'true' : undefined}
          required
        />
        <label htmlFor="email">
          Email <span className="required-mark" aria-hidden="true">*</span>
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-describedby={error ? 'forgot-password-error' : undefined}
          aria-invalid={error ? 'true' : undefined}
          required
        />
        {error && (
          <p id="forgot-password-error" className="auth-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="auth-submit" disabled={submitting}>
          Send reset link
        </button>
        <p className="auth-link">
          <Link to="/login">Back to log in</Link>
        </p>
      </form>
    </section>
  )
}

export default ForgotPasswordPage
