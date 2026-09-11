import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { fetchCsrfToken, resetPassword } from '../api/auth.js'
import './AuthForm.css'

const MIN_PASSWORD_LENGTH = 8

function errorMessage(err) {
  const code = err.response?.data?.error
  if (code === 'invalid_token' || code === 'token_expired') {
    return 'This reset link is invalid or has expired. Request a new one.'
  }
  if (code === 'invalid_password') {
    return err.response?.data?.message || `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  return 'Something went wrong. Please try again.'
}

function ResetPasswordPage() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    document.title = 'Reset password - Justintube'
  }, [])

  if (!token) {
    return (
      <section id="auth-center">
        <div className="auth-card">
          <h1>Reset password</h1>
          <p className="auth-error" role="alert">
            This reset link is invalid or missing its token.
          </p>
          <p className="auth-link">
            <Link to="/forgot-password">Request a new link</Link>
          </p>
        </div>
      </section>
    )
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (submitting) {
      return
    }

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      await fetchCsrfToken()
      await resetPassword(token, newPassword)
      setSuccess(true)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  if (success) {
    return (
      <section id="auth-center">
        <div className="auth-card">
          <h1>Reset password</h1>
          <p>Your password has been reset.</p>
          <p className="auth-link">
            <Link to="/login">Log in</Link>
          </p>
        </div>
      </section>
    )
  }

  return (
    <section id="auth-center">
      <form className="auth-card" onSubmit={handleSubmit}>
        <h1>Reset password</h1>
        <label htmlFor="newPassword">
          New password <span className="required-mark" aria-hidden="true">*</span>
        </label>
        <input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          aria-describedby={error ? 'reset-password-error' : undefined}
          aria-invalid={error ? 'true' : undefined}
          minLength={MIN_PASSWORD_LENGTH}
          required
        />
        <label htmlFor="confirmPassword">
          Confirm new password <span className="required-mark" aria-hidden="true">*</span>
        </label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          aria-describedby={error ? 'reset-password-error' : undefined}
          aria-invalid={error ? 'true' : undefined}
          minLength={MIN_PASSWORD_LENGTH}
          required
        />
        {error && (
          <p id="reset-password-error" className="auth-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="auth-submit" disabled={submitting}>
          Reset password
        </button>
      </form>
    </section>
  )
}

export default ResetPasswordPage
