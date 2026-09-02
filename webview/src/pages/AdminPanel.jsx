import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import { useTheme } from '../context/useTheme.js'
import { useSiteConfig } from '../context/useSiteConfig.js'
import {
  adminBroadcastNotification,
  adminModerationNotification,
  getAdminJobHistory,
  getAdminJobQueue,
  getUploadFileTree,
} from '../api/admin.js'
import { deleteTheme } from '../api/themes.js'
import { getTranscodeProfiles, deleteTranscodeProfile } from '../api/transcode-profiles.js'
import { searchUsers } from '../api/users.js'
import { formatRelativeDate } from '../lib/format.js'
import { JOB_KINDS, colorForJobKind, labelForJobKind } from '../lib/jobKinds.js'
import ChipInput from '../components/ChipInput.jsx'
import SegmentedProgressBar from '../components/SegmentedProgressBar.jsx'
import './AdminPanel.css'
import './AdminThemes.css'
import './AdminTranscodeProfiles.css'

const RECIPIENT_SEARCH_DEBOUNCE_MS = 300
const JOB_QUEUE_POLL_MS = 10000
const JOB_HISTORY_PAGE_SIZE = 5

function recipientLabel(user) {
  return user.displayName ? `${user.displayName} (${user.username})` : user.username
}

/**
 * Formats a byte count as a human-readable size, e.g. 1536 -> "1.5 KB".
 * @param {number|null|undefined} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) {
    return 'unknown'
  }
  if (bytes === 0) {
    return '0 B'
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

/**
 * If `raw` is a link to a page on this same server carrying a `v` query
 * param (the video-watch URL shape, `/video?v=<videoId>`), returns just that
 * videoId so it can be searched directly. Otherwise returns `raw` trimmed,
 * unchanged — including links to other origins, which are deliberately left
 * alone rather than guessed at.
 * @param {string} raw
 * @returns {string}
 */
function extractVideoIdentifierFromPastedLink(raw) {
  const trimmed = raw.trim()
  if (!trimmed) {
    return trimmed
  }
  let url
  try {
    url = new URL(trimmed, window.location.origin)
  } catch {
    return trimmed
  }
  if (url.origin !== window.location.origin) {
    return trimmed
  }
  return url.searchParams.get('v') || trimmed
}

/**
 * One leaf row in the admin file-tree explorer: a single file's on-disk
 * status, path, and size, alongside whatever DB metadata was included.
 * @param {{label: string, file: object|null}} props
 */
function FileTreeEntry({ label, file }) {
  if (!file) {
    return null
  }
  return (
    <li className="admin-file-tree-entry">
      <div className="admin-file-tree-entry-header">
        <span className="admin-file-tree-entry-label">{label}</span>
        <span
          className={`admin-file-tree-badge ${
            file.existsOnDisk ? 'admin-file-tree-badge-ok' : 'admin-file-tree-badge-missing'
          }`}
        >
          {file.existsOnDisk ? 'on disk' : 'missing'}
        </span>
        {file.status && <span className="admin-file-tree-badge">{file.status}</span>}
        {file.resolution && <span className="admin-file-tree-badge">{file.resolution}</span>}
      </div>
      <code className="admin-file-tree-path">{file.absolutePath}</code>
      <span className="admin-file-tree-meta">
        {[
          file.mimeType || file.fileExtension || null,
          file.fileSizeBytes != null ? `${formatFileSize(file.fileSizeBytes)} recorded` : null,
          file.sizeBytesOnDisk != null ? `${formatFileSize(file.sizeBytesOnDisk)} on disk` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
    </li>
  )
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

  const [fileTreeQuery, setFileTreeQuery] = useState('')
  const [fileTreeLoading, setFileTreeLoading] = useState(false)
  const [fileTreeError, setFileTreeError] = useState(null)
  const [fileTreeResult, setFileTreeResult] = useState(null)

  const [jobQueue, setJobQueue] = useState(null)
  const [jobQueueLoading, setJobQueueLoading] = useState(true)
  const [jobHistory, setJobHistory] = useState(null)
  const [jobHistoryLoading, setJobHistoryLoading] = useState(true)
  const [jobHistoryPage, setJobHistoryPage] = useState(1)
  const [jobHistoryError, setJobHistoryError] = useState(null)

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

  useEffect(() => {
    let cancelled = false

    async function loadJobQueue() {
      try {
        const data = await getAdminJobQueue()
        if (!cancelled) {
          setJobQueue(data)
        }
      } catch {
        // Best-effort - leave whatever was last shown rather than flashing
        // an error on a transient processing hiccup during a 10s poll.
      } finally {
        if (!cancelled) {
          setJobQueueLoading(false)
        }
      }
    }

    loadJobQueue()
    const interval = setInterval(loadJobQueue, JOB_QUEUE_POLL_MS)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadJobHistory() {
      setJobHistoryLoading(true)
      try {
        const data = await getAdminJobHistory({ page: jobHistoryPage, limit: JOB_HISTORY_PAGE_SIZE })
        if (!cancelled) {
          setJobHistory(data)
          setJobHistoryError(null)
        }
      } catch {
        if (!cancelled) {
          setJobHistoryError('Failed to load job history.')
        }
      } finally {
        if (!cancelled) {
          setJobHistoryLoading(false)
        }
      }
    }

    loadJobHistory()
    return () => {
      cancelled = true
    }
  }, [jobHistoryPage])

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

  async function handleFileTreeLookup(event) {
    event.preventDefault()
    const identifier = fileTreeQuery.trim()
    if (!identifier || fileTreeLoading) {
      return
    }
    setFileTreeLoading(true)
    setFileTreeError(null)
    setFileTreeResult(null)
    try {
      const data = await getUploadFileTree(identifier)
      setFileTreeResult(data)
    } catch (err) {
      setFileTreeError(
        err.response?.status === 404
          ? 'No upload found for that identifier.'
          : err.response?.data?.message || 'Failed to look up files.',
      )
    } finally {
      setFileTreeLoading(false)
    }
  }

  function handleFileTreeQueryPaste(event) {
    const pasted = event.clipboardData.getData('text')
    const isolated = extractVideoIdentifierFromPastedLink(pasted)
    if (isolated !== pasted.trim()) {
      event.preventDefault()
      setFileTreeQuery(isolated)
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

  const jobQueueSegments = JOB_KINDS.map((kind) => {
    const counts = jobQueue?.counts?.[kind]
    const value = counts ? counts.waiting + counts.active + counts.delayed : 0
    return { key: kind, value, color: colorForJobKind(kind), label: labelForJobKind(kind) }
  })
  const jobHistoryTotalPages = jobHistory
    ? Math.max(1, Math.ceil(jobHistory.total / JOB_HISTORY_PAGE_SIZE))
    : 1

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

        <div className="settings-card">
          <h2>Video File Explorer</h2>
          <p className="admin-file-tree-hint">
            Look up every file stored for an upload — pkid, internal uuid, or public video id
            all work, or paste a link to a video on this site to auto-fill its id.
          </p>
          <form className="settings-form admin-file-tree-form" onSubmit={handleFileTreeLookup}>
            <label htmlFor="admin-file-tree-query">Video identifier</label>
            <div className="admin-file-tree-search-row">
              <input
                id="admin-file-tree-query"
                type="text"
                value={fileTreeQuery}
                onChange={(event) => setFileTreeQuery(event.target.value)}
                onPaste={handleFileTreeQueryPaste}
                placeholder="pkid, uuid, video id, or a link"
                disabled={fileTreeLoading}
              />
              <button
                type="submit"
                className="settings-submit"
                disabled={fileTreeLoading || !fileTreeQuery.trim()}
              >
                {fileTreeLoading ? 'Looking up...' : 'Look up'}
              </button>
            </div>
          </form>

          {fileTreeError && <p className="settings-status settings-status-error">{fileTreeError}</p>}

          {fileTreeResult && (
            <div className="admin-file-tree">
              <div className="admin-file-tree-upload-meta">
                <span><strong>ID:</strong> {fileTreeResult.upload.id}</span>
                <span><strong>Video ID:</strong> {fileTreeResult.upload.videoId}</span>
                <span><strong>UUID:</strong> {fileTreeResult.upload.uuid}</span>
                <span><strong>Type:</strong> {fileTreeResult.upload.mediaType}</span>
                <span><strong>Status:</strong> {fileTreeResult.upload.status}</span>
              </div>
              <ul className="admin-file-tree-list">
                <FileTreeEntry label="Original" file={fileTreeResult.files.original} />
                <FileTreeEntry label="Embed video" file={fileTreeResult.files.embedVideo} />
                <FileTreeEntry label="Thumbnail" file={fileTreeResult.files.thumbnail} />
                {fileTreeResult.files.transcoded.map((variant) => (
                  <FileTreeEntry
                    key={variant.id}
                    label={`Transcoded — ${variant.resolution || variant.uuidName}`}
                    file={variant}
                  />
                ))}
                {fileTreeResult.files.transcoded.length === 0 && (
                  <li className="admin-file-tree-empty">No transcoded variants.</li>
                )}
              </ul>
            </div>
          )}
        </div>

        <div className="settings-card">
          <h2>Processing Queue</h2>
          {!transcodingEnabled && (
            <p className="admin-jobs-hint">
              Transcoding is disabled on this server (ENABLE_TRANSCODING=false) — the
              processing queue is expected to stay empty.
            </p>
          )}

          <div className="admin-jobs-section">
            <h3 className="admin-jobs-subheading">Live queue</h3>
            {jobQueueLoading && !jobQueue ? (
              <p className="settings-status">Loading queue...</p>
            ) : (
              <SegmentedProgressBar segments={jobQueueSegments} emptyLabel="Queue is empty." />
            )}
          </div>

          <div className="admin-jobs-section">
            <h3 className="admin-jobs-subheading">Recent activity</h3>
            {jobHistoryLoading && !jobHistory && (
              <p className="settings-status">Loading history...</p>
            )}
            {jobHistoryError && (
              <p className="settings-status settings-status-error">{jobHistoryError}</p>
            )}
            {jobHistory && jobHistory.items.length === 0 && (
              <p className="settings-status">No completed jobs yet.</p>
            )}
            {jobHistory && jobHistory.items.length > 0 && (
              <ul className="admin-jobs-history-list">
                {jobHistory.items.map((item) => (
                  <li key={item.jobId} className="admin-jobs-history-item">
                    <span className="admin-jobs-kind-badge" style={{ color: colorForJobKind(item.kind) }}>
                      {labelForJobKind(item.kind)}
                    </span>
                    <span
                      className={
                        item.state === 'failed'
                          ? 'admin-jobs-state-badge admin-jobs-state-failed'
                          : 'admin-jobs-state-badge admin-jobs-state-completed'
                      }
                    >
                      {item.state}
                    </span>
                    <span className="admin-jobs-history-time">
                      {formatRelativeDate(item.finishedOn)}
                    </span>
                    {item.failedReason && (
                      <span className="admin-jobs-history-reason">{item.failedReason}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {jobHistory && jobHistory.total > JOB_HISTORY_PAGE_SIZE && (
              <div className="admin-jobs-pagination">
                <button
                  type="button"
                  onClick={() => setJobHistoryPage((page) => Math.max(1, page - 1))}
                  disabled={jobHistoryPage <= 1 || jobHistoryLoading}
                >
                  Previous
                </button>
                <span className="admin-jobs-pagination-label">
                  Page {jobHistoryPage} of {jobHistoryTotalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setJobHistoryPage((page) => page + 1)}
                  disabled={jobHistoryPage >= jobHistoryTotalPages || jobHistoryLoading}
                >
                  Next
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

export default AdminPanel
