import { Component } from 'react'

/**
 * Top-level render-error catcher. Deliberately self-contained (inline
 * styles, no index.css classes) so a crash rooted in theming/CSS still
 * renders a readable fallback instead of a blank page.
 */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, info) {
    console.error('Unhandled render error:', error, info)
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children
    }

    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1rem',
          padding: '2rem',
          textAlign: 'center',
          fontFamily: 'system-ui, sans-serif',
          background: '#111318',
          color: '#f2f2f2',
        }}
      >
        <h1 style={{ fontSize: '1.5rem', margin: 0 }}>Something went wrong.</h1>
        <p style={{ margin: 0, color: '#b7bcc7', maxWidth: '32rem' }}>
          The page hit an unexpected error. Reloading usually fixes it.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: '0.5rem 1.25rem',
              borderRadius: '6px',
              border: 'none',
              background: '#3b82f6',
              color: '#fff',
              fontSize: '1rem',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
          <a
            href="/"
            style={{
              padding: '0.5rem 1.25rem',
              borderRadius: '6px',
              border: '1px solid #3b3f4a',
              color: '#f2f2f2',
              textDecoration: 'none',
              fontSize: '1rem',
            }}
          >
            Go home
          </a>
        </div>
      </div>
    )
  }
}

export default ErrorBoundary
