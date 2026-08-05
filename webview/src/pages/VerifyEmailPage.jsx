import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { fetchCsrfToken, verifyEmail } from '../api/auth.js'
import './AuthForm.css'

const REDIRECT_SECONDS = 5

function errorMessage(err) {
  const code = err.response?.data?.error
  if (code === 'already_verified') {
    return 'This email is already verified.'
  }
  if (code === 'token_expired') {
    return 'This verification link has expired. Request a new one from your profile.'
  }
  if (code === 'invalid_token' || code === 'invalid_body') {
    return 'This verification link is invalid.'
  }
  return 'Something went wrong. Please try again.'
}

function VerifyEmailPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [status, setStatus] = useState('verifying')
  const [error, setError] = useState(null)
  const [countdown, setCountdown] = useState(REDIRECT_SECONDS)
  const redirectedRef = useRef(false)
  // Verification tokens are one-time-use: guard against React StrictMode's
  // dev-mode double effect invocation sending the same token twice, which
  // would consume it on the first request and fail the second as invalid.
  // Unlike a typical data fetch, this action must not be treated as
  // "cancelled" by StrictMode's synthetic unmount — it only ever runs once,
  // and its result is applied whenever the request settles.
  const startedRef = useRef(false)

  useEffect(() => {
    document.title = 'Verify email - Justintube'
  }, [])

  useEffect(() => {
    if (startedRef.current) {
      return
    }
    startedRef.current = true

    async function run() {
      const token = searchParams.get('token')
      if (!token) {
        setError('This verification link is missing its token.')
        setStatus('error')
        return
      }

      try {
        await fetchCsrfToken()
        await verifyEmail(token)
        setStatus('success')
      } catch (err) {
        setError(errorMessage(err))
        setStatus('error')
      }
    }

    run()
  }, [searchParams])

  useEffect(() => {
    if (status !== 'success') {
      return undefined
    }

    if (countdown <= 0) {
      if (!redirectedRef.current) {
        redirectedRef.current = true
        navigate('/')
      }
      return undefined
    }

    const timer = setTimeout(() => setCountdown((prev) => prev - 1), 1000)
    return () => clearTimeout(timer)
  }, [status, countdown, navigate])

  return (
    <section id="auth-center">
      <div className="auth-card verify-email-card">
        <h1>Verify email</h1>
        {status === 'verifying' && <p>Verifying your email...</p>}
        {status === 'success' && (
          <>
            <p>Email verification complete.</p>
            <p className="auth-link">
              Redirecting to home in {countdown} second{countdown === 1 ? '' : 's'}...
            </p>
          </>
        )}
        {status === 'error' && <p className="auth-error">{error}</p>}
      </div>
    </section>
  )
}

export default VerifyEmailPage
