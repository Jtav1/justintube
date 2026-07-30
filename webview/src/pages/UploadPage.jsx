import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { UploadCloud } from 'lucide-react'
import { useAuth } from '../context/useAuth.js'
import {
  uploadVideoFile,
  importVideoUrl,
  updateVideo,
  setVideoAccess,
  setVideoFeatured,
  getImportStatus,
  updateVideoThumbnail,
  getVideo,
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

// Mirrors webapi's VIDEO_METADATA.title / .description and CONTENT_TAGS.tag
// column limits (see webapi/lib/models/video-metadata.js,
// webapi/lib/models/content-tag.js, and MAX_TAGS/MAX_TAG_LENGTH in
// webapi/routes/videos.js) so the form can't submit values the API would reject.
const MAX_TITLE_LENGTH = 255
const MAX_DESCRIPTION_LENGTH = 65535
const MAX_TAG_LENGTH = 255
const MAX_TAGS = 50

function recipientLabel(user) {
  return user.displayName ? `${user.displayName} (${user.username})` : user.username
}

const AUDIO_EXTENSION_PATTERN = /\.(mp3|wav|m4a|aac|flac|ogg|oga|opus)$/i

function isAudioFile(file) {
  if (!file) {
    return false
  }
  if (file.type) {
    return file.type.startsWith('audio/')
  }
  return AUDIO_EXTENSION_PATTERN.test(file.name || '')
}

function UploadPage() {
  const { user, loading: authLoading } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const fileInputRef = useRef(null)
  const thumbnailInputRef = useRef(null)

  const editVideoId = searchParams.get('v')
  const isEditMode = Boolean(editVideoId)
  const [editUpload, setEditUpload] = useState(null)
  const [editLoading, setEditLoading] = useState(isEditMode)
  const [editError, setEditError] = useState(null)
  const [editForbidden, setEditForbidden] = useState(false)

  const [file, setFile] = useState(null)
  const [dragActive, setDragActive] = useState(false)
  const [url, setUrl] = useState('')
  const [thumbnailFile, setThumbnailFile] = useState(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState('public')
  const [featured, setFeatured] = useState(false)

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
    if (!isEditMode || authLoading || !user) {
      return undefined
    }

    let cancelled = false

    async function loadForEdit() {
      setEditLoading(true)
      setEditError(null)
      setEditForbidden(false)
      try {
        const video = await getVideo(editVideoId)
        if (cancelled) {
          return
        }
        const canEdit = user.role === 'admin' || video.uploader?.userId === user.id
        if (!canEdit) {
          setEditForbidden(true)
          return
        }
        setEditUpload(video)
        setTitle(video.title ?? '')
        setDescription(video.description ?? '')
        setVisibility(video.visibility ?? 'public')
        setTags(video.tags ?? [])
        setFeatured(Boolean(video.featured))
      } catch {
        if (!cancelled) {
          setEditError('Failed to load this video.')
        }
      } finally {
        if (!cancelled) {
          setEditLoading(false)
        }
      }
    }

    loadForEdit()

    return () => {
      cancelled = true
    }
  }, [isEditMode, editVideoId, authLoading, user])

  useEffect(() => {
    if (isEditMode) {
      return undefined
    }

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
  }, [isEditMode])

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

  if (isEditMode && editLoading) {
    return null
  }

  if (isEditMode && editForbidden) {
    return (
      <section className="upload-page">
        <div className="upload-card">
          <h1>Edit Video</h1>
          <p className="upload-error">You don't have permission to edit this video.</p>
        </div>
      </section>
    )
  }

  if (isEditMode && editError) {
    return (
      <section className="upload-page">
        <div className="upload-card">
          <h1>Edit Video</h1>
          <p className="upload-error">{editError}</p>
        </div>
      </section>
    )
  }

  const isAdmin = user.role === 'admin'
  const canUpload = isAdmin || (user.uploader && user.emailVerified)

  if (!isEditMode && !canUpload) {
    return (
      <section className="upload-page">
        <div className="upload-card">
          <h1>Upload</h1>
          <p className="upload-error">
            You need uploader access and a verified email to upload videos.
          </p>
        </div>
      </section>
    )
  }

  const fileLocked = url.trim().length > 0
  const urlLocked = file != null
  const selectedFileIsAudio = isAudioFile(file)

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
      .map((part) => part.trim().slice(0, MAX_TAG_LENGTH))
      .filter(Boolean)
    if (parts.length === 0) {
      return
    }
    setTags((prev) => {
      const additions = parts.filter((part) => !prev.includes(part))
      return [...prev, ...additions].slice(0, MAX_TAGS)
    })
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

  const submitDisabled = isEditMode
    ? title.trim().length === 0 || submitting
    : (!file && url.trim().length === 0) || title.trim().length === 0 || submitting

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
    if (isEditMode) {
      createdId = editUpload.id
    } else {
      try {
        const uploaded = file ? await uploadVideoFile(file) : await importVideoUrl(url.trim())
        createdId = uploaded.id
      } catch {
        setSubmitError(
          file
            ? 'Failed to upload the file. Please try again.'
            : 'Failed to import the video from that URL. Please try again.',
        )
        setSubmitting(false)
        return
      }
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
        isEditMode
          ? 'Failed to save your changes. Please try again.'
          : `Your video was uploaded but its details could not be saved. ` +
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

    if (isAdmin) {
      try {
        await setVideoFeatured(createdId, featured)
      } catch {
        setSubmitError(
          'Your video was saved, but its featured status could not be updated.',
        )
        setSubmitting(false)
        return
      }
    }

    setSubmitting(false)
    navigate(isEditMode ? `/video?v=${editVideoId}` : `/users/${user.username}`)
  }

  return (
    <section className="upload-page">
      <form className="upload-card" onSubmit={handleSubmit} onKeyDown={handleFormKeyDown}>
        <h1>{isEditMode ? 'Edit Video' : 'Upload'}</h1>

        {!isEditMode && (
          <>
            <div className="upload-source-row">
              <div
                className={`upload-dropzone${fileLocked ? ' upload-dropzone-disabled' : ''}${dragActive ? ' upload-dropzone-active' : ''}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => !fileLocked && fileInputRef.current?.click()}
              >
                <UploadCloud size={28} />
                <p>{file ? file.name : 'Drag & drop a video or audio file, or click to choose a file'}</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*,audio/*"
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

            {selectedFileIsAudio && (
              <p className="upload-hint">
                Audio uploads use a standard placeholder thumbnail.
              </p>
            )}

            {!importAvailable && !selectedFileIsAudio && (
              <div className="upload-field-group">
                <label>Thumbnail</label>
                <p className="upload-hint">
                  Automatic thumbnail generation is unavailable right now — you can upload one
                  manually instead.
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
          </>
        )}

        <label htmlFor="upload-title">Title</label>
        <input
          id="upload-title"
          type="text"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={MAX_TITLE_LENGTH}
          required
        />

        <label htmlFor="upload-description">Description</label>
        <textarea
          id="upload-description"
          rows={3}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={MAX_DESCRIPTION_LENGTH}
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

        {isAdmin && (
          <label className="upload-checkbox">
            <input
              type="checkbox"
              checked={featured}
              onChange={(event) => setFeatured(event.target.checked)}
            />
            Featured
          </label>
        )}

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
            inputMaxLength={MAX_TAG_LENGTH}
          />
        </div>

        {submitError && <p className="upload-error">{submitError}</p>}

        <button type="submit" className="upload-submit" disabled={submitDisabled}>
          {isEditMode
            ? submitting
              ? 'Saving...'
              : 'Save Changes'
            : submitting
              ? 'Uploading...'
              : 'Upload'}
        </button>
      </form>
    </section>
  )
}

export default UploadPage
