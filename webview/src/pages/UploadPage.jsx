import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { UploadCloud } from 'lucide-react'
import { useAuth } from '../context/useAuth.js'
import { useSiteConfig } from '../context/useSiteConfig.js'
import { useToast } from '../context/useToast.js'
import {
  uploadVideoFile,
  importVideoUrl,
  updateVideo,
  deleteVideo,
  setVideoEditors,
  setVideoViewers,
  getVideoAccess,
  setVideoFeatured,
  getImportStatus,
  updateVideoThumbnail,
  regenerateVideoThumbnail,
  retranscodeVideo,
  rebuildVideoRemux,
  listVideoSubtitles,
  uploadVideoSubtitle,
  updateVideoSubtitleLabel,
  deleteVideoSubtitle,
  regenerateVideoSubtitles,
  getVideo,
} from '../api/videos.js'
import { searchUsers } from '../api/users.js'
import ChipInput from '../components/ChipInput.jsx'
import ProgressBar from '../components/ProgressBar.jsx'
import ToggleSwitch from '../components/ToggleSwitch.jsx'
import BulkUploadForm from '../components/BulkUploadForm.jsx'
import { VISIBILITY_OPTIONS } from '../constants/visibility.js'
import './UploadPage.css'

const RECIPIENT_SEARCH_DEBOUNCE_MS = 300
const IMPORT_STATUS_POLL_MS = 30000
// Brief buffering pause (spinner shown) after a successful new-upload
// submission, before navigating away.
const POST_UPLOAD_DELAY_MS = 2000

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

// Mirrors webapi's `thumbnailTimestamp` parsing (seconds, non-negative,
// at most one decimal place — e.g. "5.5" but not "5.55").
const THUMBNAIL_TIMESTAMP_PATTERN = /^\d+(\.\d)?$/

function thumbnailTimestampError(raw) {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return null
  }
  if (!THUMBNAIL_TIMESTAMP_PATTERN.test(trimmed) || !Number.isFinite(Number(trimmed))) {
    return 'Enter a number of seconds with at most 1 decimal place (e.g. 5.5).'
  }
  return null
}

let bulkCardIdCounter = 0

function createEmptyBulkCard() {
  return {
    id: ++bulkCardIdCounter,
    file: null,
    title: '',
    visibility: 'public',
    status: 'idle',
    progress: 0,
    error: null,
  }
}

function titleFromFilename(name) {
  const dotIndex = name.lastIndexOf('.')
  return dotIndex > 0 ? name.slice(0, dotIndex) : name
}

// Fills the first empty-file card with the first new file, appends fresh
// cards (pre-filled) for any remaining files, then ensures the list always
// ends with exactly one empty card - the standing drop/click target for
// whatever file comes next.
function addFilesToBulkCards(prevCards, files) {
  const next = [...prevCards]
  let fileIndex = 0

  for (let i = 0; i < next.length && fileIndex < files.length; i++) {
    if (next[i].file == null) {
      const selected = files[fileIndex]
      next[i] = {
        ...next[i],
        file: selected,
        title: next[i].title.trim() ? next[i].title : titleFromFilename(selected.name),
      }
      fileIndex++
    }
  }

  while (fileIndex < files.length) {
    const selected = files[fileIndex]
    next.push({ ...createEmptyBulkCard(), file: selected, title: titleFromFilename(selected.name) })
    fileIndex++
  }

  if (next.length === 0 || next[next.length - 1].file != null) {
    next.push(createEmptyBulkCard())
  }

  return next
}

function UploadPage() {
  const { user, loading: authLoading } = useAuth()
  const { transcodingEnabled } = useSiteConfig()
  const { success, error: toastError } = useToast()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const fileInputRef = useRef(null)
  const thumbnailInputRef = useRef(null)
  const subtitleInputRef = useRef(null)

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
  const [bulkMode, setBulkMode] = useState(false)
  const [bulkCards, setBulkCards] = useState(() => [createEmptyBulkCard()])
  const [thumbnailFile, setThumbnailFile] = useState(null)
  const [thumbnailTimestamp, setThumbnailTimestamp] = useState('')
  const [subtitleFile, setSubtitleFile] = useState(null)
  const [subtitleLabel, setSubtitleLabel] = useState('')
  const [subtitleRegenerating, setSubtitleRegenerating] = useState(false)
  const [subtitlesList, setSubtitlesList] = useState([])
  const [addingSubtitle, setAddingSubtitle] = useState(false)
  const [editingSubtitleId, setEditingSubtitleId] = useState(null)
  const [editingLabelDraft, setEditingLabelDraft] = useState('')
  const [savingSubtitleLabel, setSavingSubtitleLabel] = useState(false)
  const [deletingSubtitleId, setDeletingSubtitleId] = useState(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState('public')
  const [featured, setFeatured] = useState(false)

  const [tagInput, setTagInput] = useState('')
  const [tags, setTags] = useState([])

  const [viewerQuery, setViewerQuery] = useState('')
  const [viewerSuggestions, setViewerSuggestions] = useState([])
  const [viewerSearchLoading, setViewerSearchLoading] = useState(false)
  const [viewers, setViewers] = useState([])

  const [editorsExpanded, setEditorsExpanded] = useState(false)
  const [editorQuery, setEditorQuery] = useState('')
  const [editorSuggestions, setEditorSuggestions] = useState([])
  const [editorSearchLoading, setEditorSearchLoading] = useState(false)
  const [editors, setEditors] = useState([])

  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // In-flight state for the admin-only edit-mode actions at the bottom of
  // the form - each is independent of the main save/delete flow and never
  // navigates away or touches the form's own fields.
  const [adminRegeneratingThumbnail, setAdminRegeneratingThumbnail] = useState(false)
  const [adminRetranscoding, setAdminRetranscoding] = useState(false)
  const [adminRebuildingRemux, setAdminRebuildingRemux] = useState(false)
  // True for the brief spinner pause between a successful new-upload
  // submission and navigating away (see POST_UPLOAD_DELAY_MS).
  const [postUploadPending, setPostUploadPending] = useState(false)

  const [importAvailable, setImportAvailable] = useState(true)

  // Tracks the in-flight file transfer only — the transcode/download work
  // that follows creation is queued server-side and runs independently of
  // this page, so there's nothing further to wait on or poll here.
  const [uploadPercent, setUploadPercent] = useState(null)

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

        try {
          const { items } = await listVideoSubtitles(video.id)
          if (!cancelled) {
            setSubtitlesList(items)
          }
        } catch {
          if (!cancelled) {
            setSubtitlesList([])
          }
        }

        if (isOwnerAdmin) {
          const { items } = await getVideoAccess(video.id)
          if (!cancelled) {
            const toRef = (item) => ({
              userId: item.userId,
              username: item.username,
              displayName: item.displayName,
            })
            const editorItems = items.filter((item) => item.permission === 'edit').map(toRef)
            setEditors(editorItems)
            setEditorsExpanded(editorItems.length > 0)
            if (video.visibility === 'private') {
              setViewers(items.filter((item) => item.permission === 'view').map(toRef))
            }
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

  const viewerSearchActive = visibility === 'private' && viewerQuery.trim().length > 0

  useEffect(() => {
    if (!viewerSearchActive) {
      return undefined
    }

    const timer = setTimeout(async () => {
      setViewerSearchLoading(true)
      try {
        const { items } = await searchUsers(viewerQuery.trim(), { limit: 8 })
        const alreadyAdded = new Set(viewers.map((r) => r.userId))
        setViewerSuggestions(items.filter((item) => !alreadyAdded.has(item.userId)))
      } catch {
        setViewerSuggestions([])
      } finally {
        setViewerSearchLoading(false)
      }
    }, RECIPIENT_SEARCH_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [viewerSearchActive, viewerQuery, viewers])

  const editorSearchActive = editorsExpanded && editorQuery.trim().length > 0

  useEffect(() => {
    if (!editorSearchActive) {
      return undefined
    }

    const timer = setTimeout(async () => {
      setEditorSearchLoading(true)
      try {
        const { items } = await searchUsers(editorQuery.trim(), { limit: 8 })
        const alreadyAdded = new Set(editors.map((r) => r.userId))
        setEditorSuggestions(items.filter((item) => !alreadyAdded.has(item.userId)))
      } catch {
        setEditorSuggestions([])
      } finally {
        setEditorSearchLoading(false)
      }
    }, RECIPIENT_SEARCH_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [editorSearchActive, editorQuery, editors])

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

  if (postUploadPending) {
    return (
      <section className="upload-page">
        <div className="upload-card upload-card-pending">
          <div className="upload-pending-spinner" />
          <p>Finishing up...</p>
        </div>
      </section>
    )
  }

  const fileLocked = url.trim().length > 0
  const urlLocked = file != null
  const selectedFileIsAudio = isAudioFile(file)
  // Audio uploads never get an auto-generated thumbnail (see
  // finalizeUploadTranscodes on the server) - hide the frame-timestamp field
  // in edit mode so it's not offered for something that can't do anything.
  const isEditingAudio = isEditMode && editUpload?.mediaType === 'audio'

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

  function handleSubtitleInputChange(event) {
    const selected = event.target.files?.[0]
    event.target.value = ''
    if (!selected) {
      return
    }
    // Defense-in-depth - the server also validates the extension.
    if (!/\.(srt|vtt)$/i.test(selected.name)) {
      toastError('Subtitles must be a .srt or .vtt file.')
      return
    }
    setSubtitleFile(selected)
  }

  async function handleRegenerateSubtitles() {
    if (subtitleRegenerating || !editUpload) {
      return
    }
    setSubtitleRegenerating(true)
    try {
      await regenerateVideoSubtitles(editUpload.id)
      success('Captions are regenerating — this may take a moment.')
    } catch (err) {
      console.error('Failed to regenerate captions:', err)
      toastError(err.response?.data?.message || 'Failed to regenerate captions.')
    } finally {
      setSubtitleRegenerating(false)
    }
  }

  async function handleAddSubtitle() {
    if (!editUpload || !subtitleFile || addingSubtitle) {
      return
    }
    const label = subtitleLabel.trim()
    if (!label) {
      toastError('Enter a label for this subtitle.')
      return
    }
    setAddingSubtitle(true)
    try {
      const created = await uploadVideoSubtitle(editUpload.id, subtitleFile, label)
      setSubtitlesList((prev) => [...prev, created])
      setSubtitleFile(null)
      setSubtitleLabel('')
      success('Subtitle added.')
    } catch {
      toastError('Failed to add the subtitle. Please try again.')
    } finally {
      setAddingSubtitle(false)
    }
  }

  function handleStartRenameSubtitle(subtitle) {
    setEditingSubtitleId(subtitle.id)
    setEditingLabelDraft(subtitle.label)
  }

  function handleCancelRenameSubtitle() {
    setEditingSubtitleId(null)
    setEditingLabelDraft('')
  }

  async function handleSaveSubtitleLabel(subtitleId) {
    if (savingSubtitleLabel) {
      return
    }
    const label = editingLabelDraft.trim()
    if (!label) {
      toastError('Label cannot be empty.')
      return
    }
    setSavingSubtitleLabel(true)
    try {
      const updated = await updateVideoSubtitleLabel(editUpload.id, subtitleId, label)
      setSubtitlesList((prev) => prev.map((item) => (item.id === subtitleId ? updated : item)))
      setEditingSubtitleId(null)
      setEditingLabelDraft('')
    } catch {
      toastError('Failed to rename the subtitle.')
    } finally {
      setSavingSubtitleLabel(false)
    }
  }

  async function handleDeleteSubtitle(subtitle) {
    if (deletingSubtitleId) {
      return
    }
    if (!window.confirm(`Delete the "${subtitle.label}" subtitle? This cannot be undone.`)) {
      return
    }
    setDeletingSubtitleId(subtitle.id)
    try {
      await deleteVideoSubtitle(editUpload.id, subtitle.id)
      setSubtitlesList((prev) => prev.filter((item) => item.id !== subtitle.id))
    } catch {
      toastError('Failed to delete the subtitle.')
    } finally {
      setDeletingSubtitleId(null)
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

  function handleBulkModeToggle(checked) {
    setBulkMode(checked)
    setBulkCards([createEmptyBulkCard()])
    setFile(null)
    setUrl('')
  }

  function handleBulkAddFiles(files) {
    setBulkCards((prev) => addFilesToBulkCards(prev, files))
  }

  function handleBulkUpdateCard(id, patch) {
    setBulkCards((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  }

  function handleBulkRemoveCard(id) {
    setBulkCards((prev) => prev.filter((c) => c.id !== id))
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

  function addViewer(userId) {
    const match = viewerSuggestions.find((s) => s.userId === Number(userId))
    if (!match) {
      return
    }
    setViewers((prev) => [...prev, match])
    setViewerQuery('')
    setViewerSuggestions([])
  }

  function removeViewer(userId) {
    setViewers((prev) => prev.filter((r) => r.userId !== Number(userId)))
  }

  function addEditor(userId) {
    const match = editorSuggestions.find((s) => s.userId === Number(userId))
    if (!match) {
      return
    }
    setEditors((prev) => [...prev, match])
    setEditorQuery('')
    setEditorSuggestions([])
  }

  function removeEditor(userId) {
    setEditors((prev) => prev.filter((r) => r.userId !== Number(userId)))
  }

  // In edit mode an empty value means "leave the thumbnail alone" (not
  // "random frame" like on a fresh upload), but it's still validated
  // whenever the field is non-empty.
  const thumbnailTimestampInvalid =
    !thumbnailFile && thumbnailTimestampError(thumbnailTimestamp) != null
  // Only relevant on a fresh upload - in edit mode, subtitles are added
  // immediately via their own "Add subtitle" button, not deferred to submit.
  const subtitleLabelMissing =
    !isEditMode && Boolean(subtitleFile) && subtitleLabel.trim().length === 0

  const submitDisabled = isEditMode
    ? title.trim().length === 0 || thumbnailTimestampInvalid || submitting
    : (!file && url.trim().length === 0) ||
      title.trim().length === 0 ||
      thumbnailTimestampInvalid ||
      subtitleLabelMissing ||
      submitting

  const bulkPopulatedCards = bulkCards.filter((c) => c.file)
  const bulkSubmitDisabled =
    submitting || bulkPopulatedCards.length === 0 || bulkPopulatedCards.some((c) => c.title.trim().length === 0)

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

  function finishUploadFlow(message) {
    success(message)
    setPostUploadPending(true)
    setTimeout(() => navigate(`/users/${user.username}`), POST_UPLOAD_DELAY_MS)
  }

  async function handleBulkSubmit() {
    if (bulkSubmitDisabled) {
      return
    }

    const toUpload = bulkCards.filter((c) => c.file && c.status !== 'success')
    setSubmitting(true)
    let hadError = false

    for (const card of toUpload) {
      handleBulkUpdateCard(card.id, { status: 'uploading', progress: 0, error: null })
      try {
        const uploaded = await uploadVideoFile(card.file, {
          onUploadProgress: (event) => {
            if (event.total) {
              handleBulkUpdateCard(card.id, { progress: Math.round((event.loaded / event.total) * 100) })
            }
          },
        })
        await updateVideo(uploaded.id, {
          title: card.title.trim(),
          description: null,
          tags: [],
          visibility: card.visibility,
        })
        handleBulkUpdateCard(card.id, { status: 'success', progress: 100 })
      } catch {
        hadError = true
        handleBulkUpdateCard(card.id, { status: 'error', error: 'Upload failed.' })
      }
    }

    setSubmitting(false)

    if (hadError) {
      toastError('Some videos failed to upload. Fix them and click Upload again.')
    } else {
      finishUploadFlow('Videos uploaded! They will finish processing in the background.')
    }
  }

  async function handleSubmit(event) {
    event.preventDefault()

    if (bulkMode) {
      await handleBulkSubmit()
      return
    }

    if (submitDisabled) {
      return
    }

    setSubmitting(true)

    // A supplied thumbnail file always wins; otherwise a requested timestamp
    // (already validated via thumbnailTimestampInvalid) picks the
    // auto-generated frame, and an empty value falls back to processing's
    // default (random) frame.
    const trimmedThumbnailTimestamp = thumbnailTimestamp.trim()
    const thumbnailTimestampToSend =
      !thumbnailFile && trimmedThumbnailTimestamp !== '' ? Number(trimmedThumbnailTimestamp) : undefined

    let createdId
    if (isEditMode) {
      createdId = editUpload.id
    } else {
      try {
        const uploaded = file
          ? await uploadVideoFile(file, {
              skipThumbnail: Boolean(thumbnailFile),
              thumbnailTimestamp: thumbnailTimestampToSend,
              skipAutoSubtitles: Boolean(subtitleFile),
              onUploadProgress: (event) => {
                if (event.total) {
                  setUploadPercent(Math.round((event.loaded / event.total) * 100))
                }
              },
            })
          : await importVideoUrl(url.trim(), {
              skipThumbnail: Boolean(thumbnailFile),
              thumbnailTimestamp: thumbnailTimestampToSend,
              skipAutoSubtitles: Boolean(subtitleFile),
            })
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
    } else if (isEditMode && thumbnailTimestampToSend !== undefined) {
      try {
        await regenerateVideoThumbnail(createdId, thumbnailTimestampToSend)
      } catch (err) {
        const reason = err.response?.data?.message
        toastError(
          reason
            ? `Your changes were saved, but the thumbnail could not be regenerated: ${reason}`
            : 'Your changes were saved, but the thumbnail could not be regenerated. ' +
                'You can try again from the edit page.',
        )
        setSubmitting(false)
        return
      }
    }

    if (!isEditMode && subtitleFile) {
      try {
        await uploadVideoSubtitle(createdId, subtitleFile, subtitleLabel.trim())
      } catch {
        toastError(
          'Your video was uploaded and configured, but the subtitle file could not be saved. ' +
            'You can try uploading it again from the edit page.',
        )
        setSubmitting(false)
        return
      }
    }

    if (viewerIsOwnerOrAdmin) {
      try {
        await setVideoEditors(
          createdId,
          editors.map((r) => r.username),
        )
      } catch {
        toastError(
          'Your video was uploaded and configured, but setting editors failed. ' +
            'You can manage editors from your profile.',
        )
        setSubmitting(false)
        return
      }
    }

    if (viewerIsOwnerOrAdmin && visibility === 'private') {
      try {
        await setVideoViewers(
          createdId,
          viewers.map((r) => r.username),
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

    // Download/transcode work is queued server-side and continues
    // independently of this page — no need to wait around for it. A brief
    // spinner pause before navigating away gives the success toast a moment
    // to register instead of instantly redirecting.
    finishUploadFlow('Video uploaded! It will finish processing in the background.')
  }

  async function handleDelete() {
    if (deleting || submitting) {
      return
    }
    if (!window.confirm(`Delete "${title || editUpload.title}"? This cannot be undone.`)) {
      return
    }

    setDeleting(true)
    try {
      await deleteVideo(editUpload.id)
    } catch {
      toastError('Failed to delete the video. Please try again.')
      setDeleting(false)
      return
    }

    success('Video deleted.')
    navigate(`/users/${user.username}`)
  }

  // Admin-only edit-mode actions below - each just fires a request and
  // shows a toast; none of them touch the form's own fields, submit it, or
  // navigate away.

  async function handleAdminRegenerateThumbnail() {
    if (adminRegeneratingThumbnail) {
      return
    }
    setAdminRegeneratingThumbnail(true)
    try {
      await regenerateVideoThumbnail(editUpload.id)
      success('Thumbnail regeneration queued.')
    } catch (err) {
      toastError(err.response?.data?.message || 'Failed to queue thumbnail regeneration.')
    } finally {
      setAdminRegeneratingThumbnail(false)
    }
  }

  async function handleAdminRetranscode() {
    if (adminRetranscoding) {
      return
    }
    setAdminRetranscoding(true)
    try {
      await retranscodeVideo(editUpload.id)
      success('Re-transcode queued.')
    } catch (err) {
      toastError(err.response?.data?.message || 'Failed to queue re-transcode.')
    } finally {
      setAdminRetranscoding(false)
    }
  }

  async function handleAdminRebuildRemux() {
    if (adminRebuildingRemux) {
      return
    }
    setAdminRebuildingRemux(true)
    try {
      await rebuildVideoRemux(editUpload.id)
      success('Remux container rebuild queued.')
    } catch (err) {
      toastError(err.response?.data?.message || 'Failed to queue remux container rebuild.')
    } finally {
      setAdminRebuildingRemux(false)
    }
  }

  return (
    <section className="upload-page">
      <form className="upload-card" onSubmit={handleSubmit} onKeyDown={handleFormKeyDown}>
        <h1>{isEditMode ? 'Edit Video' : 'Upload'}</h1>

        {!isEditMode && (
          <ToggleSwitch
            id="upload-bulk-toggle"
            label="Bulk Upload"
            checked={bulkMode}
            onChange={handleBulkModeToggle}
          />
        )}

        {!isEditMode && bulkMode && (
          <BulkUploadForm
            cards={bulkCards}
            visibilityOptions={VISIBILITY_OPTIONS}
            disabled={submitting}
            onAddFiles={handleBulkAddFiles}
            onUpdateCard={handleBulkUpdateCard}
            onRemoveCard={handleBulkRemoveCard}
          />
        )}

        {!isEditMode && !bulkMode && (
          <>
            <div className="upload-source-row">
              <label
                htmlFor="upload-dropzone-input"
                className={`upload-dropzone${fileLocked ? ' upload-dropzone-disabled' : ''}${dragActive ? ' upload-dropzone-active' : ''}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <UploadCloud size={28} />
                <p>{file ? file.name : 'Drag & drop a video or audio file, or click to choose a file'}</p>
                <input
                  id="upload-dropzone-input"
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
              </label>

              {importAvailable && (
                <>
                  <div className="upload-or">or</div>

                  <div className="upload-url-field">
                    <label htmlFor="upload-url"><b>Import from URL</b> - EXPERIMENTAL!<br />youtube links may fail silently</label>
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

        {!bulkMode && (
          <>
          <div className="upload-field-group">
            <label htmlFor="upload-thumbnail-input">Thumbnail</label>
            {!isEditMode && !importAvailable && (
              <p className="upload-hint">
                Automatic thumbnail generation is unavailable right now. You can upload one
                manually instead.
              </p>
            )}
            <div className="upload-thumbnail-row">
              <label htmlFor="upload-thumbnail-input" className="upload-thumbnail-picker">
                <UploadCloud size={20} />
                <span>{thumbnailFile ? thumbnailFile.name : 'Choose a thumbnail image'}</span>
                <input
                  id="upload-thumbnail-input"
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
              </label>

              {!isEditingAudio && transcodingEnabled && (
                <div className="upload-thumbnail-timestamp">
                  <label htmlFor="upload-thumbnail-timestamp">Frame at (sec)</label>
                  <input
                    id="upload-thumbnail-timestamp"
                    type="text"
                    inputMode="decimal"
                    value={thumbnailTimestamp}
                    onChange={(event) => setThumbnailTimestamp(event.target.value)}
                    disabled={Boolean(thumbnailFile)}
                    placeholder={isEditMode ? 'e.g."1.5"' : 'Random'}
                    aria-invalid={thumbnailTimestampInvalid}
                  />
                  {thumbnailTimestampInvalid && (
                    <p className="upload-error upload-thumbnail-timestamp-error">
                      {thumbnailTimestampError(thumbnailTimestamp)}
                    </p>
                  )}
                </div>
              )}
            </div>
            {isEditMode && !isEditingAudio && transcodingEnabled && (
              <p className="upload-hint">
                Specifying a timestamp (in seconds) to replace thumbnail with that frame
              </p>
            )}
          </div>

          <div className="upload-field-group">
            <label htmlFor="upload-subtitle-input">Subtitles</label>

            {isEditMode && subtitlesList.length > 0 && (
              <div className="upload-subtitle-list">
                {subtitlesList.map((subtitle) => (
                  <div className="upload-subtitle-row" key={subtitle.id}>
                    {editingSubtitleId === subtitle.id ? (
                      <>
                        <input
                          type="text"
                          className="upload-subtitle-rename-input"
                          value={editingLabelDraft}
                          maxLength={100}
                          onChange={(event) => setEditingLabelDraft(event.target.value)}
                          autoFocus
                        />
                        <div className="upload-subtitle-actions">
                          <button
                            type="button"
                            onClick={() => handleSaveSubtitleLabel(subtitle.id)}
                            disabled={savingSubtitleLabel}
                          >
                            {savingSubtitleLabel ? 'Saving…' : 'Save'}
                          </button>
                          <button type="button" onClick={handleCancelRenameSubtitle}>
                            Cancel
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <span className="upload-subtitle-label">{subtitle.label}</span>
                        <span className="upload-subtitle-badge">
                          {subtitle.source === 'auto' ? 'Auto' : 'User'}
                        </span>
                        <div className="upload-subtitle-actions">
                          <button type="button" onClick={() => handleStartRenameSubtitle(subtitle)}>
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteSubtitle(subtitle)}
                            disabled={deletingSubtitleId === subtitle.id}
                          >
                            {deletingSubtitleId === subtitle.id ? 'Deleting…' : 'Delete'}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="upload-thumbnail-row">
              <label htmlFor="upload-subtitle-input" className="upload-thumbnail-picker">
                <UploadCloud size={20} />
                <span>{subtitleFile ? subtitleFile.name : 'Add subtitles (.srt or .vtt)'}</span>
                <input
                  id="upload-subtitle-input"
                  ref={subtitleInputRef}
                  type="file"
                  accept=".srt,.vtt"
                  className="upload-dropzone-input"
                  onChange={handleSubtitleInputChange}
                />
                {subtitleFile && (
                  <button
                    type="button"
                    className="upload-dropzone-clear"
                    onClick={(event) => {
                      event.stopPropagation()
                      setSubtitleFile(null)
                      setSubtitleLabel('')
                    }}
                  >
                    Clear
                  </button>
                )}
              </label>
              {isEditMode && transcodingEnabled && (
                <button
                  type="button"
                  className="upload-link-button"
                  style={{ alignSelf: 'center' }}
                  onClick={handleRegenerateSubtitles}
                  disabled={subtitleRegenerating}
                >
                  {subtitleRegenerating ? 'Regenerating…' : 'Extract from File'}
                </button>
              )}
            </div>

            {subtitleFile && (
              <input
                type="text"
                className="upload-subtitle-label-input"
                placeholder="Label, e.g. English"
                value={subtitleLabel}
                maxLength={100}
                onChange={(event) => setSubtitleLabel(event.target.value)}
              />
            )}

            {isEditMode && subtitleFile && (
              <button
                type="button"
                className="upload-link-button"
                onClick={handleAddSubtitle}
                disabled={addingSubtitle || subtitleLabel.trim().length === 0}
              >
                {addingSubtitle ? 'Adding…' : 'Add subtitle'}
              </button>
            )}

            <p className="upload-hint">
              {isEditMode
                ? transcodingEnabled
                  ? 'Add a labeled subtitle file, or attempt to auto-extract subtitles from the video file'
                  : 'Add a labeled subtitle file'
                : 'Add a labeled subtitle file, uploaded alongside the video'}
            </p>
          </div>

          <label htmlFor="upload-title">
            Title <span className="required-mark" aria-hidden="true">*</span>
          </label>
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
                chips={viewers.map((r) => ({ key: String(r.userId), label: recipientLabel(r) }))}
                onRemove={removeViewer}
                inputValue={viewerQuery}
                onInputChange={setViewerQuery}
                suggestions={
                  viewerSearchActive
                    ? viewerSuggestions.map((s) => ({
                        key: String(s.userId),
                        label: recipientLabel(s),
                      }))
                    : []
                }
                onSelectSuggestion={addViewer}
                suggestionsLoading={viewerSearchLoading}
                placeholder="Search by username or display name..."
              />
            </div>
          )}

          {viewerIsOwnerOrAdmin && !editorsExpanded && (
            <button
              type="button"
              className="upload-link-button"
              onClick={() => setEditorsExpanded(true)}
            >
              + Add Editors
            </button>
          )}

          {viewerIsOwnerOrAdmin && editorsExpanded && (
            <div className="upload-field-group">
              <label>Editors</label>
              <ChipInput
                chips={editors.map((r) => ({ key: String(r.userId), label: recipientLabel(r) }))}
                onRemove={removeEditor}
                inputValue={editorQuery}
                onInputChange={setEditorQuery}
                suggestions={
                  editorSearchActive
                    ? editorSuggestions.map((s) => ({
                        key: String(s.userId),
                        label: recipientLabel(s),
                      }))
                    : []
                }
                onSelectSuggestion={addEditor}
                suggestionsLoading={editorSearchLoading}
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

          {uploadPercent != null && (
            <ProgressBar value={uploadPercent} label={`Uploading (${uploadPercent}%)...`} />
          )}
          </>
        )}

        <button
          type="submit"
          className="upload-submit"
          disabled={bulkMode ? bulkSubmitDisabled : submitDisabled}
        >
          {isEditMode
            ? submitting
              ? 'Saving...'
              : 'Save Changes'
            : submitting
              ? 'Uploading...'
              : 'Upload'}
        </button>

        {isEditMode && viewerIsOwnerOrAdmin && (
          <button
            type="button"
            className="upload-delete"
            onClick={handleDelete}
            disabled={submitting || deleting}
          >
            {deleting ? 'Deleting...' : 'Delete Video'}
          </button>
        )}

        {isEditMode && isAdmin && transcodingEnabled && (
          <div className="upload-field-group upload-admin-actions">
            <label>Admin actions</label>
            <div className="upload-admin-actions-buttons">
              <button
                type="button"
                className="upload-link-button"
                onClick={handleAdminRegenerateThumbnail}
                disabled={adminRegeneratingThumbnail}
              >
                {adminRegeneratingThumbnail ? 'Regenerating…' : 'Regenerate Thumbnail'}
              </button>
              <button
                type="button"
                className="upload-link-button"
                onClick={handleAdminRetranscode}
                disabled={adminRetranscoding}
              >
                {adminRetranscoding ? 'Queuing…' : 'Re-transcode'}
              </button>
              <button
                type="button"
                className="upload-link-button"
                onClick={handleAdminRebuildRemux}
                disabled={adminRebuildingRemux}
              >
                {adminRebuildingRemux ? 'Queuing…' : 'Re-build Remux Container'}
              </button>
            </div>
          </div>
        )}
      </form>
    </section>
  )
}

export default UploadPage
