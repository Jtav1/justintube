import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import { useTheme } from '../context/useTheme.js'
import { useSiteConfig } from '../context/useSiteConfig.js'
import { adminBroadcastNotification, adminModerationNotification } from '../api/admin.js'
import { deleteTheme } from '../api/themes.js'
import { getTranscodeProfiles, deleteTranscodeProfile } from '../api/transcode-profiles.js'
import { searchUsers } from '../api/users.js'
import ChipInput from '../components/ChipInput.jsx'
import './AdminPanel.css'
import './AdminThemes.css'
import './AdminTranscodeProfiles.css'

const RECIPIENT_SEARCH_DEBOUNCE_MS = 300

function recipientLabel(user) {
  return user.displayName ? `${user.displayName} (${user.username})` : user.username
}

function AdminPanel() {
  const { user, loading: authLoading } = useAuth()
  const { success, error: toastError } = useToast()
  const { themes, loading: themesLoading, refreshThemes } = useTheme()
  const { transcodingEnabled } = useSiteConfig()

  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [audience, setAudience] = useState('all')
  const [recipientQuery, setRecipientQuery] = useState('')
  const [recipientSuggestions, setRecipientSuggestions] = useState([])
  const [recipientSearchLoading, setRecipientSearchLoading] = useState(false)
  const [recipients, setRecipients] = useState([])

  const [deletingThemeId, setDeletingThemeId] = useState(null)

  const [profiles, setProfiles] = useState([])
  const [profilesLoading, setProfilesLoading] = useState(true)
  const [deletingProfileId, setDeletingProfileId] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function loadProfiles() {
      try {
        const data = await getTranscodeProfiles()
        if (!cancelled) {
          setProfiles(data.items)
        }
      } catch {
        if (!cancelled) {
          toastError('Failed to load transcoding profiles.')
        }
      } finally {
        if (!cancelled) {
          setProfilesLoading(false)
        }
      }
    }
    loadProfiles()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const recipientSearchActive = audience === 'specific' && recipientQuery.trim().length > 0

  useEffect(() => {
    if (!recipientSearchActive) {
      return undefined
    }

    const timer = setTimeout(async () => {
      setRecipientSearchLoading(true)
      try {
        const { items } = await searchUsers(recipientQuery.trim(), { limit: 8 })
        const alreadyAdded = new Set(recipients.map((r) => r.userId))
        setRecipientSuggestions(items.filter((item) => !alreadyAdded.has(item.userId)))
      } catch {
        setRecipientSuggestions([])
      } finally {
        setRecipientSearchLoading(false)
      }
    }, RECIPIENT_SEARCH_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [recipientSearchActive, recipientQuery, recipients])

  if (authLoading) {
    return (
      <section className="settings-page">
        <p className="settings-status">Loading...</p>
      </section>
    )
  }

  if (!user || user.role !== 'admin') {
    return (
      <section className="settings-page">
        <p className="settings-status settings-status-error">
          You are not authorized to view this page.
        </p>
      </section>
    )
  }

  async function handleDeleteTheme(item) {
    if (deletingThemeId) {
      return
    }
    if (!window.confirm(`Delete the theme "${item.name}"? This cannot be undone.`)) {
      return
    }
    setDeletingThemeId(item.id)
    try {
      await deleteTheme(item.id)
      await refreshThemes()
      success('Theme deleted.')
    } catch (err) {
      toastError(err.response?.data?.message || 'Failed to delete theme.')
    } finally {
      setDeletingThemeId(null)
    }
  }

  async function handleDeleteProfile(profile) {
    if (deletingProfileId || !transcodingEnabled) {
      return
    }
    if (!window.confirm(`Delete the transcoding profile "${profile.resolutionName} (${profile.mediaType})"? This cannot be undone.`)) {
      return
    }
    setDeletingProfileId(profile.id)
    try {
      await deleteTranscodeProfile(profile.id)
      setProfiles((prev) => prev.filter((item) => item.id !== profile.id))
      success('Transcoding profile deleted.')
    } catch (err) {
      toastError(err.response?.data?.message || 'Failed to delete transcoding profile.')
    } finally {
      setDeletingProfileId(null)
    }
  }

  function addRecipient(userId) {
    const match = recipientSuggestions.find((s) => s.userId === Number(userId))
    if (!match) {
      return
    }
    setRecipients((prev) => [...prev, match])
    setRecipientQuery('')
    setRecipientSuggestions([])
  }

  function removeRecipient(userId) {
    setRecipients((prev) => prev.filter((r) => r.userId !== Number(userId)))
  }

  const notifySubmitDisabled =
    sending || title.trim().length === 0 || message.trim().length === 0 ||
    (audience === 'specific' && recipients.length === 0)

  async function handleSubmit(event) {
    event.preventDefault()
    if (notifySubmitDisabled) {
      return
    }

    const confirmMessage =
      audience === 'all'
        ? 'Send this notification to every user? This cannot be undone.'
        : `Send this moderation notification to ${recipients.length} user(s)? This cannot be undone.`
    if (!window.confirm(confirmMessage)) {
      return
    }

    setSending(true)
    try {
      const result =
        audience === 'all'
          ? await adminBroadcastNotification(title.trim(), message.trim())
          : await adminModerationNotification(
              title.trim(),
              message.trim(),
              recipients.map((r) => r.userId),
            )
      setTitle('')
      setMessage('')
      setRecipients([])
      success(`Notification sent to ${result.notifiedCount} user(s).`)
    } catch (err) {
      const code = err.response?.data?.error
      toastError(code === 'invalid_body' ? err.response.data.message : 'Failed to send notification.')
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="settings-page">
      <div className="admin-panel-columns">
        <div className="settings-card">
          <h1>Admin Panel</h1>
          <h2>Send a notification</h2>

          <form className="settings-form" onSubmit={handleSubmit}>
            <label htmlFor="admin-notify-audience">Send to</label>
            <select
              id="admin-notify-audience"
              value={audience}
              onChange={(event) => setAudience(event.target.value)}
              disabled={sending}
            >
              <option value="all">All users (sitewide broadcast)</option>
              <option value="specific">Specific users (moderation)</option>
            </select>

            <label htmlFor="admin-broadcast-title">Title</label>
            <input
              id="admin-broadcast-title"
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={255}
              required
              disabled={sending}
            />

            <label htmlFor="admin-broadcast-message">Content</label>
            <textarea
              id="admin-broadcast-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={5000}
              rows={5}
              required
              disabled={sending}
            />

            {audience === 'specific' && (
              <div className="upload-field-group">
                <label>Recipients</label>
                <ChipInput
                  chips={recipients.map((r) => ({ key: String(r.userId), label: recipientLabel(r) }))}
                  onRemove={removeRecipient}
                  inputValue={recipientQuery}
                  onInputChange={setRecipientQuery}
                  suggestions={
                    recipientSearchActive
                      ? recipientSuggestions.map((s) => ({
                          key: String(s.userId),
                          label: recipientLabel(s),
                        }))
                      : []
                  }
                  onSelectSuggestion={addRecipient}
                  suggestionsLoading={recipientSearchLoading}
                  placeholder="Search by username or display name..."
                />
              </div>
            )}

            <button type="submit" className="settings-submit" disabled={notifySubmitDisabled}>
              {sending
                ? 'Sending...'
                : audience === 'all'
                  ? 'Send to all users'
                  : 'Send to selected users'}
            </button>
          </form>
        </div>

        <div className="settings-card">
          <h2>Manage Themes</h2>
          <Link to="/control-panel/themes/new" className="settings-submit admin-themes-create-link">
            Create Theme
          </Link>
          <div className="admin-themes-list">
            {themesLoading && <p className="settings-status">Loading themes...</p>}
            {!themesLoading && themes.map((item) => (
              <div className="admin-themes-row" key={item.id}>
                <div className="admin-themes-swatches">
                  {['color2', 'color3', 'color4', 'color5'].map((key) => (
                    <span
                      key={key}
                      className="admin-themes-swatch"
                      style={{ backgroundColor: `#${item.colors[key]}` }}
                    />
                  ))}
                </div>
                <span className="admin-themes-name">{item.name}</span>
                {item.isDefault && <span className="admin-themes-badge">Default</span>}
                <div className="admin-themes-actions">
                  <Link to={`/control-panel/themes/${item.id}/edit`}>Edit</Link>
                  <button
                    type="button"
                    onClick={() => handleDeleteTheme(item)}
                    disabled={deletingThemeId === item.id}
                  >
                    {deletingThemeId === item.id ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="settings-card">
          <h2>Manage Transcoding Profiles</h2>
          {!transcodingEnabled && (
            <p className="admin-profiles-hint">
              Transcoding is disabled on this server (ENABLE_TRANSCODING=false) — profile
              management is read-only.
            </p>
          )}
          {transcodingEnabled && (
            <Link to="/control-panel/transcode-profiles/new" className="settings-submit admin-profiles-create-link">
              Create Profile
            </Link>
          )}
          <div className="admin-profiles-list">
            {profilesLoading && <p className="settings-status">Loading transcoding profiles...</p>}
            {!profilesLoading && profiles.map((item) => (
              <div className="admin-profiles-row" key={item.id}>
                <span className="admin-profiles-name">
                  {item.resolutionName} &middot; {item.outputWidth}x{item.outputHeight} &middot;{' '}
                  {item.videoCodec}/{item.audioCodec} &middot; {item.outputContainer}
                </span>
                <span className="admin-profiles-badge">{item.mediaType}</span>
                {item.hardwareAccelerated && (
                  <span className="admin-profiles-badge">HW</span>
                )}
                {transcodingEnabled && (
                  <div className="admin-profiles-actions">
                    <Link to={`/control-panel/transcode-profiles/${item.id}/edit`}>Edit</Link>
                    <button
                      type="button"
                      onClick={() => handleDeleteProfile(item)}
                      disabled={deletingProfileId === item.id}
                    >
                      {deletingProfileId === item.id ? 'Deleting...' : 'Delete'}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

export default AdminPanel
