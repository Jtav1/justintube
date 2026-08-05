import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/useAuth.js'
import './AuthForm.css'

function errorMessage(err) {
  const data = err.response?.data
  const code = data?.error
  if (code === 'registration_disabled') {
    return 'Registration is currently disabled.'
  }
  if (code === 'invalid_password') {
    return data.message
  }
  if (code === 'conflict') {
    return 'Username or email is already registered.'
  }
  return 'Something went wrong. Please try again.'
}

function RegisterPage() {
  const { register } = useAuth()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    document.title = 'Register - Justintube'
  }, [])

  async function handleSubmit(event) {
    event.preventDefault()
    if (submitting) {
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      await register(username, email, password)
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
        <h1>Register</h1>
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
          aria-describedby={error ? 'register-error' : undefined}
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
          aria-describedby={error ? 'register-error' : undefined}
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
          autoComplete="new-password"
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-describedby={error ? 'register-error' : undefined}
          aria-invalid={error ? 'true' : undefined}
          required
        />
        {error && (
          <p id="register-error" className="auth-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="auth-submit" disabled={submitting}>
          Register
        </button>
        <p className="auth-link">
          Already have an account? <Link to="/login">Log in</Link>
        </p>
      </form>
    </section>
  )
}

export default RegisterPage
