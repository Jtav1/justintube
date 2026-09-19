import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/useAuth.js'
import { useCast } from '../context/useCast.js'
import './AuthForm.css'

/**
 * Owns the `/cast/join` deep link: what a QR code / shared join link points
 * at. Not logged in -> bounces to `/login` with a return-here `state.from`
 * so scanning the code while logged out still lands back here post-login.
 * Logged in with a `?code=` -> auto-joins. No code (or a failed auto-join)
 * falls back to a manual code-entry form, since a plain popover can't own a
 * shareable URL the way this route does.
 */
function CastJoinPage() {
  const { user, loading: authLoading } = useAuth()
  const { joinByCode } = useCast()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const codeFromUrl = (searchParams.get('code') || '').toUpperCase()

  const [code, setCode] = useState(codeFromUrl)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const autoJoinAttemptedRef = useRef(false)

  useEffect(() => {
    document.title = 'Join CAST session - Justintube'
  }, [])

  useEffect(() => {
    if (authLoading || user) {
      return
    }
    navigate('/login', {
      state: { from: `/cast/join${codeFromUrl ? `?code=${codeFromUrl}` : ''}` },
    })
  }, [authLoading, user, navigate, codeFromUrl])

  async function attemptJoin(value) {
    setSubmitting(true)
    setError(null)
    try {
      const result = await joinByCode(value)
      navigate(`/cast/${result.session.id}`)
    } catch (err) {
      setError(err.message || 'Failed to join CAST session.')
    } finally {
      setSubmitting(false)
    }
  }

  useEffect(() => {
    if (authLoading || !user || !codeFromUrl || autoJoinAttemptedRef.current) {
      return
    }
    autoJoinAttemptedRef.current = true
    attemptJoin(codeFromUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user, codeFromUrl])

  function handleSubmit(event) {
    event.preventDefault()
    if (!code.trim() || submitting) {
      return
    }
    attemptJoin(code.trim())
  }

  if (authLoading || !user) {
    return (
      <section id="auth-center">
        <p>Loading…</p>
      </section>
    )
  }

  return (
    <section id="auth-center">
      <form className="auth-card" onSubmit={handleSubmit}>
        <h1>Join CAST session</h1>
        <p>Enter the session code shown on the host&apos;s screen.</p>
        <label htmlFor="cast-join-code">
          Code <span className="required-mark" aria-hidden="true">*</span>
        </label>
        <input
          id="cast-join-code"
          name="code"
          type="text"
          autoComplete="off"
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          maxLength={8}
          aria-describedby={error ? 'cast-join-error' : undefined}
          aria-invalid={error ? 'true' : undefined}
          required
        />
        {error && (
          <p id="cast-join-error" className="auth-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="auth-submit" disabled={submitting}>
          {submitting ? 'Joining…' : 'Join'}
        </button>
        <p className="auth-link">
          <Link to="/">Back to Justintube</Link>
        </p>
      </form>
    </section>
  )
}

export default CastJoinPage
