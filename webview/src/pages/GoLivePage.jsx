import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Copy, Radio } from 'lucide-react'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import {
  getMyLivestream,
  getMyStreamKey,
  rotateMyStreamKey,
  revokeMyStreamKey,
  updateLivestream,
} from '../api/livestreams.js'
import './GoLivePage.css'

const VISIBILITY_OPTIONS = [
  { value: 'public', label: 'Public' },
  { value: 'private', label: 'Private' },
  { value: 'unlisted', label: 'Unlisted' },
  { value: 'hidden', label: 'Hidden' },
]

// Mirrors webapi's LIVESTREAMS.title / .description column limits (see
// webapi/routes/livestreams.js) so the form can't submit values the API
// would reject.
const MAX_TITLE_LENGTH = 255
const MAX_DESCRIPTION_LENGTH = 65535

function GoLivePage() {
  const { user, loading: authLoading } = useAuth()
  const { success, error: toastError } = useToast()
  const navigate = useNavigate()

  const [streamKey, setStreamKey] = useState(null)
  const [keyLoading, setKeyLoading] = useState(true)
  const [revealedKey, setRevealedKey] = useState(null)
  const [copied, setCopied] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [revoking, setRevoking] = useState(false)

  const [liveStatus, setLiveStatus] = useState(null)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState('public')
  const [livestreamId, setLivestreamId] = useState(null)
  const [saving, setSaving] = useState(false)

  const canGoLive = Boolean(user && (user.role === 'admin' || (user.uploader && user.emailVerified)))

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/login')
    }
  }, [authLoading, user, navigate])

  useEffect(() => {
    if (authLoading || !user || !canGoLive) {
      return undefined
    }

    let cancelled = false

    async function load() {
      setKeyLoading(true)
      try {
        const key = await getMyStreamKey()
        if (!cancelled) {
          setStreamKey(key)
        }
      } catch (err) {
        if (!cancelled && err.response?.status !== 404) {
          toastError('Failed to load your stream key.')
        }
      } finally {
        if (!cancelled) {
          setKeyLoading(false)
        }
      }

      try {
        const livestream = await getMyLivestream()
        if (!cancelled) {
          setLivestreamId(livestream.id)
          setTitle(livestream.title ?? '')
          setDescription(livestream.description ?? '')
          setVisibility(livestream.visibility ?? 'public')
          setLiveStatus({ live: livestream.status === 'live' })
        }
      } catch (err) {
        if (!cancelled && err.response?.status !== 404) {
          toastError('Failed to load your livestream details.')
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [authLoading, user, canGoLive, toastError])

  if (authLoading || !user) {
    return null
  }

  if (!canGoLive) {
    return (
      <section className="golive-page">
        <div className="golive-card">
          <h1>Go Live</h1>
          <p className="golive-hint">
            Livestreaming requires uploader access and a verified email. Visit your account settings
            to verify your email, or request uploader access.
          </p>
        </div>
      </section>
    )
  }

  async function handleGetOrRotateKey() {
    setRotating(true)
    try {
      const created = await rotateMyStreamKey()
      const metadata = { ...created }
      delete metadata.key
      delete metadata.livestreamId
      setStreamKey(metadata)
      setRevealedKey(created)
      if (created.livestreamId) {
        setLivestreamId(created.livestreamId)
      }
      success(streamKey ? 'Stream key rotated.' : 'Stream key created.')
    } catch {
      toastError('Failed to generate a stream key. Please try again.')
    } finally {
      setRotating(false)
    }
  }

  async function handleRevoke() {
    if (!window.confirm('Revoke your stream key? OBS (or any encoder using it) will stop working immediately.')) {
      return
    }
    setRevoking(true)
    try {
      await revokeMyStreamKey()
      setStreamKey(null)
      setRevealedKey(null)
      success('Stream key revoked.')
    } catch {
      toastError('Failed to revoke the stream key. Please try again.')
    } finally {
      setRevoking(false)
    }
  }

  async function handleCopyRevealedKey() {
    try {
      await navigator.clipboard.writeText(revealedKey.key)
      setCopied(true)
    } catch {
      toastError('Could not copy automatically - please copy it manually.')
    }
  }

  function dismissRevealedKey() {
    setRevealedKey(null)
    setCopied(false)
  }

  async function handleSaveDetails(event) {
    event.preventDefault()
    if (!livestreamId) {
      toastError('Generate a stream key first - it creates your stream.')
      return
    }
    setSaving(true)
    try {
      await updateLivestream(livestreamId, {
        title: title.trim() || null,
        description: description.trim() || null,
        visibility,
      })
      success('Stream details saved.')
    } catch {
      toastError('Failed to save stream details. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="golive-page">
      <div className="golive-card">
        <div className="golive-header">
          <h1>Go Live</h1>
          {liveStatus?.live && (
            <span className="golive-status-badge golive-status-live">
              <Radio size={12} />
              Live
            </span>
          )}
        </div>

        <p className="golive-hint">
          Configure your stream, then plug the RTMP details below into OBS (or any RTMP-compatible
          encoder) to publish - the Server value goes in OBS&apos;s &quot;Server&quot; field, and
          your stream key goes in its &quot;Stream Key&quot; field.
        </p>

        {revealedKey && (
          <div className="golive-reveal">
            <p className="golive-reveal-title">
              Copy your stream key now - you won&apos;t be able to see it again.
            </p>
            <div className="golive-reveal-row">
              <code className="golive-reveal-code">{revealedKey.key}</code>
              <button type="button" className="golive-secondary-button" onClick={handleCopyRevealedKey}>
                <Copy size={14} />
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <button type="button" className="golive-secondary-button" onClick={dismissRevealedKey}>
              Done
            </button>
          </div>
        )}

        <div className="golive-section">
          <h2>Stream Key</h2>
          {keyLoading ? (
            <p className="golive-status">Loading...</p>
          ) : streamKey ? (
            <div className="golive-key-details">
              <div className="golive-field-row">
                <span className="golive-field-label">RTMP URL</span>
                <code className="golive-field-value">{streamKey.ingestUrl || 'Not configured'}</code>
              </div>
              <div className="golive-field-row">
                <span className="golive-field-label">Stream Key</span>
                <code className="golive-field-value">{streamKey.keyDisplay}</code>
              </div>
              <div className="golive-form-actions">
                <button
                  type="button"
                  className="golive-secondary-button"
                  onClick={handleGetOrRotateKey}
                  disabled={rotating}
                >
                  {rotating ? 'Rotating...' : 'Rotate Key'}
                </button>
                <button
                  type="button"
                  className="golive-secondary-button golive-danger-button"
                  onClick={handleRevoke}
                  disabled={revoking}
                >
                  {revoking ? 'Revoking...' : 'Revoke Key'}
                </button>
              </div>
            </div>
          ) : (
            <div className="golive-key-details">
              <p className="golive-hint">
                You don&apos;t have a stream key yet. Generate one to get your RTMP URL and key.
              </p>
              <button
                type="button"
                className="golive-submit"
                onClick={handleGetOrRotateKey}
                disabled={rotating}
              >
                {rotating ? 'Generating...' : 'Get Stream Key'}
              </button>
            </div>
          )}
        </div>

        <form className="golive-section golive-form" onSubmit={handleSaveDetails}>
          <h2>Stream Details</h2>

          <label htmlFor="golive-title">Title</label>
          <input
            id="golive-title"
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={MAX_TITLE_LENGTH}
            placeholder="What are you streaming?"
          />

          <label htmlFor="golive-description">Description</label>
          <textarea
            id="golive-description"
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={MAX_DESCRIPTION_LENGTH}
          />

          <label htmlFor="golive-visibility">Visibility</label>
          <select
            id="golive-visibility"
            value={visibility}
            onChange={(event) => setVisibility(event.target.value)}
          >
            {VISIBILITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <div className="golive-form-actions">
            <button type="submit" className="golive-submit" disabled={saving || !livestreamId}>
              {saving ? 'Saving...' : 'Save Details'}
            </button>
          </div>
          {!livestreamId && (
            <p className="golive-hint">Get a stream key above first - it also sets up your stream.</p>
          )}
        </form>
      </div>
    </section>
  )
}

export default GoLivePage
