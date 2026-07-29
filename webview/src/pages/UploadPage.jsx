import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { UploadCloud } from 'lucide-react'
import { useAuth } from '../context/useAuth.js'
import {
  uploadVideoFile,
  updateVideo,
  setVideoAccess,
  getImportStatus,
  updateVideoThumbnail,
} from '../api/videos.js'
import { searchUsers } from '../api/users.js'
import ChipInput from '../components/ChipInput.jsx'
import './UploadPage.css'

const VISIBILITY_OPTIONS = [
  { value: 'public', label: 'Public' },
  { value: 'private', label: 'Private' },
  { value: 'unlisted', label: 'Unlisted' },
  { value: 'hidden', label: 'Hidden' },
]

const RECIPIENT_SEARCH_DEBOUNCE_MS = 300
const IMPORT_STATUS_POLL_MS = 30000

function recipientLabel(user) {
  return user.displayName ? `${user.displayName} (${user.username})` : user.username
}

function UploadPage() {
  const { user, loading: authLoading } = useAuth()
  const navigate = useNavigate()
  const fileInputRef = useRef(null)
  const thumbnailInputRef = useRef(null)

  const [file, setFile] = useState(null)
  const [dragActive, setDragActive] = useState(false)
  const [url, setUrl] = useState('')
  const [thumbnailFile, setThumbnailFile] = useState(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState('public')

  const [tagInput, setTagInput] = useState('')
  const [tags, setTags] = useState([])

  const [recipientQuery, setRecipientQuery] = useState('')
  const [recipientSuggestions, setRecipientSuggestions] = useState([])
  const [recipientSearchLoading, setRecipientSearchLoading] = useState(false)
  const [recipients, setRecipients] = useState([])

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)

  const [importAvailable, setImportAvailable] = useState(true)

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/login')
    }
  }, [authLoading, user, navigate])

  useEffect(() => {
    let cancelled = false

    async function checkImportStatus() {
      let available
      try {
        ;({ available } = await getImportStatus())
      } catch {
        available = false
      }
      if (!cancelled) {
        setImportAvailable(available)
        if (!available) {
          setUrl('')
        }
      }
    }

    checkImportStatus()
    const interval = setInterval(checkImportStatus, IMPORT_STATUS_POLL_MS)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  const recipientSearchActive = visibility === 'private' && recipientQuery.trim().length > 0

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

  if (authLoading || !user) {
    return null
  }

  const fileLocked = url.trim().length > 0
  const urlLocked = file != null

  function handleFileSelected(selectedFile) {
    setFile(selectedFile)
  }

  function handleFileInputChange(event) {
    const selected = event.target.files?.[0]
    event.target.value = ''
    if (selected) {
      handleFileSelected(selected)
    }
  }

  function handleThumbnailInputChange(event) {
    const selected = event.target.files?.[0]
    event.target.value = ''
    if (selected) {
      setThumbnailFile(selected)
    }
  }

  function handleDragOver(event) {
    event.preventDefault()
    if (!fileLocked) {
      setDragActive(true)
    }
  }

  function handleDragLeave() {
    setDragActive(false)
  }

  function handleDrop(event) {
    event.preventDefault()
    setDragActive(false)
    if (fileLocked) {
      return
    }
    const dropped = event.dataTransfer.files?.[0]
    if (dropped) {
      handleFileSelected(dropped)
    }
  }

  function addTagFromInput(rawText) {
    const parts = rawText
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
    if (parts.length === 0) {
      return
    }
    setTags((prev) => [...prev, ...parts.filter((part) => !prev.includes(part))])
    setTagInput('')
  }

  function removeTag(tag) {
    setTags((prev) => prev.filter((t) => t !== tag))
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

  const submitDisabled =
    !file || url.trim().length > 0 || title.trim().length === 0 || submitting

  function handleFormKeyDown(event) {
    if (event.key !== 'Enter') {
      return
    }
    const target = event.target
    // Textareas need Enter for newlines, and the submit button should still
    // work via Enter/Space. Everything else (text inputs, the hidden file
    // input, selects) would otherwise implicitly submit the form on Enter —
    // most noticeably right after picking a file in the native file dialog,
    // which hands focus back to the (now Enter-pressed) file input.
    if (target.tagName === 'TEXTAREA' || target.type === 'submit') {
      return
    }
    event.preventDefault()
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (submitDisabled) {
      return
    }

    setSubmitting(true)
    setSubmitError(null)

    let createdId
    try {
      const uploaded = await uploadVideoFile(file)
      createdId = uploaded.id
    } catch {
      setSubmitError('Failed to upload the file. Please try again.')
      setSubmitting(false)
      return
    }

    try {
      await updateVideo(createdId, {
        title: title.trim(),
        description: description.trim() || null,
        visibility,
        tags,
      })
    } catch {
      setSubmitError(
        `Your video was uploaded but its details could not be saved. ` +
          `You can edit it from your profile to finish setting it up.`,
      )
      setSubmitting(false)
      return
    }

    if (thumbnailFile) {
      try {
        await updateVideoThumbnail(createdId, thumbnailFile)
      } catch {
        setSubmitError(
          'Your video was uploaded and configured, but the custom thumbnail could not be saved. ' +
            'You can try uploading it again from your profile.',
        )
        setSubmitting(false)
        return
      }
    }

    if (visibility === 'private' && recipients.length > 0) {
      try {
        await setVideoAccess(
          createdId,
          recipients.map((r) => r.username),
        )
      } catch {
        setSubmitError(
          'Your video was uploaded and configured, but sharing with specific users failed. ' +
            'You can manage access from your profile.',
        )
        setSubmitting(false)
        return
      }
    }

    setSubmitting(false)
    navigate(`/users/${user.username}`)
  }

  return (
    <section className="upload-page">
      <form className="upload-card" onSubmit={handleSubmit} onKeyDown={handleFormKeyDown}>
        <h1>Upload</h1>

        <div className="upload-source-row">
          <div
            className={`upload-dropzone${fileLocked ? ' upload-dropzone-disabled' : ''}${dragActive ? ' upload-dropzone-active' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => !fileLocked && fileInputRef.current?.click()}
          >
            <UploadCloud size={28} />
            <p>{file ? file.name : 'Drag & drop a video, or click to choose a file'}</p>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              className="upload-dropzone-input"
              disabled={fileLocked}
              onChange={handleFileInputChange}
            />
            {file && (
              <button
                type="button"
                className="upload-dropzone-clear"
                onClick={(event) => {
                  event.stopPropagation()
                  setFile(null)
                }}
              >
                Clear
              </button>
            )}
          </div>

          {importAvailable && (
            <>
              <div className="upload-or">or</div>

              <div className="upload-url-field">
                <label htmlFor="upload-url">Import from URL</label>
                <input
                  id="upload-url"
                  type="text"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  disabled={urlLocked}
                  placeholder="https://..."
                />
              </div>
            </>
          )}
        </div>

        {!importAvailable && (
          <div className="upload-field-group">
            <label>Thumbnail</label>
            <p className="upload-hint">
              Automatic thumbnail generation is unavailable right now — you can upload one manually
              instead.
            </p>
            <div
              className="upload-thumbnail-picker"
              onClick={() => thumbnailInputRef.current?.click()}
            >
              <UploadCloud size={20} />
              <span>{thumbnailFile ? thumbnailFile.name : 'Choose a thumbnail image'}</span>
              <input
                ref={thumbnailInputRef}
                type="file"
                accept="image/*"
                className="upload-dropzone-input"
                onChange={handleThumbnailInputChange}
              />
              {thumbnailFile && (
                <button
                  type="button"
                  className="upload-dropzone-clear"
                  onClick={(event) => {
                    event.stopPropagation()
                    setThumbnailFile(null)
                  }}
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        )}

        <label htmlFor="upload-title">Title</label>
        <input
          id="upload-title"
          type="text"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
        />

        <label htmlFor="upload-description">Description</label>
        <textarea
          id="upload-description"
          rows={3}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />

        <label htmlFor="upload-visibility">Visibility</label>
        <select
          id="upload-visibility"
          value={visibility}
          onChange={(event) => setVisibility(event.target.value)}
        >
          {VISIBILITY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        {visibility === 'private' && (
          <div className="upload-field-group">
            <label>Share with</label>
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

        <div className="upload-field-group">
          <label>Tags</label>
          <ChipInput
            chips={tags.map((tag) => ({ key: tag, label: tag }))}
            onRemove={removeTag}
            inputValue={tagInput}
            onInputChange={setTagInput}
            onAddFreeform={addTagFromInput}
            placeholder="Add tags (comma or Enter)"
          />
        </div>

        {submitError && <p className="upload-error">{submitError}</p>}

        <button type="submit" className="upload-submit" disabled={submitDisabled}>
          {submitting ? 'Uploading...' : 'Upload'}
        </button>
      </form>
    </section>
  )
}

export default UploadPage
