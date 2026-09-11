import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Copy, KeyRound, Pencil, Trash2 } from 'lucide-react'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import { createMyApiKey, listMyApiKeys, revokeMyApiKey, updateMyApiKey } from '../api/api-keys.js'
import './ApiKeysPage.css'

// Mirrors API_KEY_SCOPE_NAMES / DEFAULT_API_KEY_SCOPES in webapi (see
// lib/auth/require-api-key-scope.js and lib/seed.js). "full_access" is a
// superset of the other three rather than something combined with them.
const SCOPE_OPTIONS = [
  { value: 'view_only', label: 'View only', description: 'Read-only access to whatever you can already view.' },
  {
    value: 'content_edit',
    label: 'Content edit',
    description: 'Create, update, and delete your videos, playlists, and comments, plus likes/hides/reports.',
  },
  {
    value: 'profile_edit',
    label: 'Profile edit',
    description: 'Update your profile, avatar/banner, theme, notification preferences, and subscriptions.',
  },
  {
    value: 'full_access',
    label: 'Full access',
    description: 'Everything above, plus managing your own API keys (and admin actions, if you are an admin).',
  },
]

const EMPTY_FORM = { name: '', description: '', scopes: [], expiresAt: '' }

function formatDate(value) {
  if (!value) {
    return null
  }
  return new Date(value).toLocaleString()
}

function scopeLabel(scope) {
  return SCOPE_OPTIONS.find((option) => option.value === scope)?.label ?? scope
}

function keyStatus(key) {
  if (key.revokedAt) {
    return { text: 'Revoked', className: 'api-keys-status-revoked' }
  }
  if (new Date(key.expiresAt).getTime() <= Date.now()) {
    return { text: 'Expired', className: 'api-keys-status-expired' }
  }
  return { text: 'Active', className: 'api-keys-status-active' }
}

// Formats a Date as the value a <input type="datetime-local"> expects (local
// time, no timezone/seconds), used to seed the expiry field when editing.
function toDateTimeLocal(value) {
  if (!value) {
    return ''
  }
  const date = new Date(value)
  const offsetMs = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16)
}

function ApiKeysPage() {
  const { user, loading: authLoading } = useAuth()
  const { success, error: toastError } = useToast()
  const navigate = useNavigate()

  const [keys, setKeys] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [revokingId, setRevokingId] = useState(null)

  const [revealedKey, setRevealedKey] = useState(null)
  const [copied, setCopied] = useState(false)

  const hasAccess = Boolean(user?.uploader && user?.emailVerified)

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/login')
    }
  }, [authLoading, user, navigate])

  useEffect(() => {
    if (authLoading || !user || !hasAccess) {
      return undefined
    }

    let cancelled = false

    async function load() {
      setLoading(true)
      setLoadError(null)
      try {
        const { items } = await listMyApiKeys()
        if (!cancelled) {
          setKeys(items)
        }
      } catch {
        if (!cancelled) {
          setLoadError('Your API keys are unavailable right now.')
          toastError('Failed to load API keys.')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [authLoading, user, hasAccess, toastError])

  if (authLoading || !user) {
    return null
  }

  if (!hasAccess) {
    return (
      <section className="api-keys-page">
        <div className="api-keys-card">
          <h1>API Keys</h1>
          <p className="api-keys-hint">
            API keys require uploader access and a verified email. Visit your account settings to
            verify your email, or request uploader access.
          </p>
        </div>
      </section>
    )
  }

  function openCreateForm() {
    setForm(EMPTY_FORM)
    setEditingId('new')
  }

  function openEditForm(key) {
    setForm({
      name: key.name,
      description: key.description ?? '',
      scopes: key.scopes,
      expiresAt: toDateTimeLocal(key.expiresAt),
    })
    setEditingId(key.id)
  }

  function closeForm() {
    setEditingId(null)
    setForm(EMPTY_FORM)
  }

  function toggleScope(scope) {
    setForm((prev) => ({
      ...prev,
      scopes: prev.scopes.includes(scope)
        ? prev.scopes.filter((s) => s !== scope)
        : [...prev.scopes, scope],
    }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (form.scopes.length === 0) {
      toastError('Select at least one scope.')
      return
    }

    setSubmitting(true)
    const isCreate = editingId === 'new'
    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      scopes: form.scopes,
      ...(form.expiresAt ? { expiresAt: new Date(form.expiresAt).toISOString() } : {}),
    }

    try {
      if (isCreate) {
        const created = await createMyApiKey(payload)
        // Keep the plaintext key only in `revealedKey` (shown once, then
        // discarded on dismiss) - the list itself only needs metadata.
        const metadata = { ...created }
        delete metadata.key
        setKeys((prev) => [metadata, ...prev])
        setRevealedKey(created)
        success('API key created.')
      } else {
        const updated = await updateMyApiKey(editingId, payload)
        setKeys((prev) => prev.map((key) => (key.id === updated.id ? updated : key)))
        success('API key updated.')
      }
      closeForm()
    } catch (err) {
      const code = err.response?.data?.error
      const message =
        code === 'forbidden'
          ? 'Uploader access and a verified email are required.'
          : (err.response?.data?.message ||
              `Failed to ${isCreate ? 'create' : 'update'} the API key. Please try again.`)
      toastError(message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRevoke(key) {
    if (revokingId) {
      return
    }
    if (!window.confirm(`Revoke "${key.name}"? Anything using this key will stop working immediately.`)) {
      return
    }

    setRevokingId(key.id)
    try {
      await revokeMyApiKey(key.id)
      setKeys((prev) =>
        prev.map((item) => (item.id === key.id ? { ...item, revokedAt: new Date().toISOString() } : item)),
      )
      success('API key revoked.')
    } catch {
      toastError('Failed to revoke the API key. Please try again.')
    } finally {
      setRevokingId(null)
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

  const isEditMode = editingId !== null && editingId !== 'new'
  const submitDisabled = form.name.trim().length === 0 || form.scopes.length === 0 || submitting

  return (
    <section className="api-keys-page">
      <div className="api-keys-card">
        <div className="api-keys-header">
          <h1>API Keys</h1>
          {editingId === null && (
            <button type="button" className="api-keys-create-button" onClick={openCreateForm}>
              <KeyRound size={16} />
              New API Key
            </button>
          )}
        </div>

        {revealedKey && (
          <div className="api-keys-reveal">
            <p className="api-keys-reveal-title">
              Copy your new key now - you won&apos;t be able to see it again.
            </p>
            <div className="api-keys-reveal-row">
              <code className="api-keys-reveal-code">{revealedKey.key}</code>
              <button type="button" className="api-keys-secondary-button" onClick={handleCopyRevealedKey}>
                <Copy size={14} />
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <button type="button" className="api-keys-secondary-button" onClick={dismissRevealedKey}>
              Done
            </button>
          </div>
        )}

        {editingId !== null && (
          <form className="api-keys-form" onSubmit={handleSubmit}>
            <h2>{isEditMode ? 'Edit API Key' : 'New API Key'}</h2>

            <label htmlFor="api-key-name">Name</label>
            <input
              id="api-key-name"
              type="text"
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              maxLength={255}
              required
            />

            <label htmlFor="api-key-description">Description</label>
            <textarea
              id="api-key-description"
              rows={2}
              value={form.description}
              onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
              maxLength={2000}
            />

            <span className="api-keys-form-label">Scopes</span>
            <div className="api-keys-scope-list">
              {SCOPE_OPTIONS.map((option) => (
                <label key={option.value} className="api-keys-scope-option">
                  <input
                    type="checkbox"
                    checked={form.scopes.includes(option.value)}
                    onChange={() => toggleScope(option.value)}
                  />
                  <span>
                    <span className="api-keys-scope-option-label">{option.label}</span>
                    <span className="api-keys-scope-option-description">{option.description}</span>
                  </span>
                </label>
              ))}
            </div>

            <label htmlFor="api-key-expires">Expires</label>
            <input
              id="api-key-expires"
              type="datetime-local"
              value={form.expiresAt}
              onChange={(event) => setForm((prev) => ({ ...prev, expiresAt: event.target.value }))}
            />
            <p className="api-keys-hint">Leave blank to default to one year from now.</p>

            <div className="api-keys-form-actions">
              <button type="submit" className="api-keys-submit" disabled={submitDisabled}>
                {submitting ? 'Saving...' : isEditMode ? 'Save Changes' : 'Create Key'}
              </button>
              <button type="button" className="api-keys-secondary-button" onClick={closeForm}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {loading ? (
          <p className="api-keys-status">Loading...</p>
        ) : loadError ? (
          <p className="api-keys-status api-keys-status-error">{loadError}</p>
        ) : keys.length === 0 ? (
          <p className="api-keys-status">You haven&apos;t created any API keys yet.</p>
        ) : (
          <ul className="api-keys-list">
            {keys.map((key) => {
              const status = keyStatus(key)
              return (
                <li key={key.id} className="api-keys-list-item">
                  <div className="api-keys-list-item-main">
                    <div className="api-keys-list-item-title-row">
                      <span className="api-keys-list-item-name">{key.name}</span>
                      <span className={`api-keys-status-badge ${status.className}`}>{status.text}</span>
                    </div>
                    {key.description && <p className="api-keys-list-item-description">{key.description}</p>}
                    <code className="api-keys-list-item-display">{key.keyDisplay}</code>
                    <div className="api-keys-scope-badges">
                      {key.scopes.map((scope) => (
                        <span key={scope} className="api-keys-scope-badge">
                          {scopeLabel(scope)}
                        </span>
                      ))}
                    </div>
                    <div className="api-keys-list-item-meta">
                      <span>Created {formatDate(key.createdAt)}</span>
                      <span>Expires {formatDate(key.expiresAt)}</span>
                    </div>
                  </div>
                  {!key.revokedAt && (
                    <div className="api-keys-list-item-actions">
                      <button
                        type="button"
                        className="api-keys-icon-button"
                        onClick={() => openEditForm(key)}
                        aria-label="Edit API key"
                        title="Edit API key"
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        type="button"
                        className="api-keys-icon-button api-keys-icon-button-danger"
                        onClick={() => handleRevoke(key)}
                        disabled={revokingId === key.id}
                        aria-label="Revoke API key"
                        title="Revoke API key"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}

export default ApiKeysPage
