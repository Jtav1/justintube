import { useState } from 'react'
import { Link } from 'react-router-dom'
import './LoginPage.css'

function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  function handleSubmit(event) {
    event.preventDefault()
  }

  return (
    <section id="login-center">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>Log in</h1>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        <button type="submit" className="login-submit">
          Log in
        </button>
        <p className="register-link">
          Don't have an account? <Link to="/register">Register</Link>
        </p>
      </form>
    </section>
  )
}

export default LoginPage
