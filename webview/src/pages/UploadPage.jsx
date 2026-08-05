import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { UploadCloud } from 'lucide-react'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import {
  uploadVideoFile,
  importVideoUrl,
  updateVideo,
  setVideoAccess,
  getVideoAccess,
  setVideoFeatured,
  getImportStatus,
  updateVideoThumbnail,
  getVideo,
  getVideoProcessingStatus,
} from '../api/videos.js'
import { searchUsers } from '../api/users.js'
import ChipInput from '../components/ChipInput.jsx'
import ProgressBar from '../components/ProgressBar.jsx'
import './UploadPage.css'

const VISIBILITY_OPTIONS = [
  { value: 'public', label: 'Public' },
  { value: 'private', label: 'Private' },
  { value: 'unlisted', label: 'Unlisted' },
  { value: 'hidden', label: 'Hidden' },
]

const RECIPIENT_SEARCH_DEBOUNCE_MS = 300
const IMPORT_STATUS_POLL_MS = 30000
const PROCESSING_POLL_MS = 2000
// Statuses GET /videos/:id/processing-status can return that mean there's
// nothing left to wait on — "uploaded" covers the zero-transcode-job case
// (e.g. an audio upload with no matching audio profiles).
const TERMINAL_UPLOAD_STATUSES = new Set(['ready', 'partial', 'failed', 'uploaded'])

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
  const { success, error: toastError } = useToast()
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
  // A fresh upload's creator is always its owner; only edit mode can set this false.
  const [viewerIsOwnerOrAdmin, setViewerIsOwnerOrAdmin] = useState(true)

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

  const [importAvailable, setImportAvailable] = useState(true)

  // Set once creation succeeds (file upload or URL import); drives the
  // processing-status poll below and switches the page from the form to a
  // progress panel. Ephemeral by design — a refresh loses this, but the
  // upload/import itself keeps running server-side regardless.
  const [uploadPercent, setUploadPercent] = useState(null)
  const [trackingId, setTrackingId] = useState(null)
  const [processingStatus, setProcessingStatus] = useState(null)

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
        const canEditMetadata = video.viewerPermission === 'owner' || video.viewerPermission === 'edit'
        if (!canEditMetadata) {
          setEditForbidden(true)
          return
        }
        const isOwnerAdmin = video.viewerPermission === 'owner'
        setViewerIsOwnerOrAdmin(isOwnerAdmin)
        setEditUpload(video)
        setTitle(video.title ?? '')
        setDescription(video.description ?? '')
        setVisibility(video.visibility ?? 'public')
        setTags(video.tags ?? [])
        setFeatured(Boolean(video.featured))

        if (isOwnerAdmin && video.visibility === 'private') {
          const { items } = await getVideoAccess(video.id)
          if (!cancelled) {
            setRecipients(
              items.map((item) => ({
                userId: item.userId,
                username: item.username,
                displayName: item.displayName,
                permission: item.permission,
              })),
            )
          }
        }
      } catch {
        if (!cancelled) {
          setEditError('This video is unavailable right now.')
          toastError('Failed to load this video.')
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
  }, [isEditMode, editVideoId, authLoading, user, toastError])

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

  useEffect(() => {
    if (!trackingId) {
      return undefined
    }

    let cancelled = false
    let interval

    async function poll() {
      try {
        const data = await getVideoProcessingStatus(trackingId)
        if (cancelled) {
          return
        }
        setProcessingStatus(data)
        if (TERMINAL_UPLOAD_STATUSES.has(data.status)) {
          clearInterval(interval)
        }
      } catch {
        // Transient network/server hiccup — the next tick retries.
      }
    }

    poll()
    interval = setInterval(poll, PROCESSING_POLL_MS)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [trackingId])

  useEffect(() => {
    if (!trackingId || !processingStatus) {
      return
    }
    if (TERMINAL_UPLOAD_STATUSES.has(processingStatus.status) && processingStatus.status !== 'failed') {
      success('Video is ready!')
      navigate(`/users/${user.username}`)
    }
  }, [trackingId, processingStatus, navigate, user.username, success])

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
          <p className="upload-hint">{editError}</p>
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
    setRecipients((prev) => [...prev, { ...match, permission: 'view' }])
    setRecipientQuery('')
    setRecipientSuggestions([])
  }

  function removeRecipient(userId) {
    setRecipients((prev) => prev.filter((r) => r.userId !== Number(userId)))
  }

  function updateRecipientPermission(userId, permission) {
    setRecipients((prev) =>
      prev.map((r) => (r.userId === Number(userId) ? { ...r, permission } : r)),
    )
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

    let createdId
    if (isEditMode) {
      createdId = editUpload.id
    } else {
      try {
        const uploaded = file
          ? await uploadVideoFile(file, {
              skipThumbnail: Boolean(thumbnailFile),
              onUploadProgress: (event) => {
                if (event.total) {
                  setUploadPercent(Math.round((event.loaded / event.total) * 100))
                }
              },
            })
          : await importVideoUrl(url.trim(), { skipThumbnail: Boolean(thumbnailFile) })
        createdId = uploaded.id
      } catch {
        toastError(
          file
            ? 'Failed to upload the file. Please try again.'
            : 'Failed to import the video from that URL. Please try again.',
        )
        setSubmitting(false)
        return
      }
      setUploadPercent(null)
    }

    try {
      const updatePayload = {
        title: title.trim(),
        description: description.trim() || null,
        tags,
      }
      if (viewerIsOwnerOrAdmin) {
        updatePayload.visibility = visibility
      }
      await updateVideo(createdId, updatePayload)
    } catch {
      toastError(
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
        toastError(
          'Your video was uploaded and configured, but the custom thumbnail could not be saved. ' +
            'You can try uploading it again from your profile.',
        )
        setSubmitting(false)
        return
      }
    }

    if (viewerIsOwnerOrAdmin && visibility === 'private') {
      try {
        await setVideoAccess(
          createdId,
          recipients.map((r) => ({ username: r.username, permission: r.permission })),
        )
      } catch {
        toastError(
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
        toastError('Your video was saved, but its featured status could not be updated.')
        setSubmitting(false)
        return
      }
    }

    setSubmitting(false)

    if (isEditMode) {
      success('Changes saved.')
      navigate(`/video?v=${editVideoId}`)
      return
    }

    // Creation + setup succeeded — hand off to the processing-status poller
    // (below) instead of navigating immediately, so the download/transcode
    // progress bar is actually visible instead of the page unmounting out
    // from under it.
    setTrackingId(createdId)
  }

  if (trackingId) {
    const status = processingStatus?.status ?? 'downloading'
    const fileVersions = processingStatus?.fileVersions ?? []
    const transcodePercent = fileVersions.length > 0
      ? Math.round(
          (fileVersions.filter((v) => v.status === 'complete').length / fileVersions.length) * 100,
        )
      : null
    return (
      <section className="upload-page">
        <div className="upload-card">
          <h1>Upload</h1>
          {status === 'downloading' && (
            <ProgressBar indeterminate label="Downloading..." />
          )}
          {status === 'processing' && (
            transcodePercent != null
              ? <ProgressBar value={transcodePercent} label={`Processing (${transcodePercent}%)...`} />
              : <ProgressBar indeterminate label="Processing..." />
          )}
          {status === 'failed' && (
            <p className="upload-error">
              {processingStatus?.statusMessage || 'This import failed. Please try again.'}
            </p>
          )}
        </div>
      </section>
    )
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
                Audio uploads use a standard placeholder thumbnail unless you upload one below.
              </p>
            )}
          </>
        )}

        <div className="upload-field-group">
          <label>Thumbnail</label>
          {!isEditMode && !importAvailable && (
            <p className="upload-hint">
              Automatic thumbnail generation is unavailable right now — you can upload one
              manually instead.
            </p>
          )}
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
          disabled={isEditMode && !viewerIsOwnerOrAdmin}
        >
          {VISIBILITY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {isEditMode && !viewerIsOwnerOrAdmin && (
          <p className="upload-hint">Only the owner or an admin can change visibility.</p>
        )}

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

        {viewerIsOwnerOrAdmin && visibility === 'private' && (
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
              renderChipExtra={(chip) => (
                <select
                  className="chip-input-permission"
                  value={recipients.find((r) => String(r.userId) === chip.key)?.permission ?? 'view'}
                  onChange={(event) => updateRecipientPermission(chip.key, event.target.value)}
                >
                  <option value="view">View</option>
                  <option value="edit">Edit</option>
                </select>
              )}
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

        {uploadPercent != null && (
          <ProgressBar value={uploadPercent} label={`Uploading (${uploadPercent}%)...`} />
        )}

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
