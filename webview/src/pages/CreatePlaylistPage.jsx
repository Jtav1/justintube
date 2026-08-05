import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import { getVideo } from '../api/videos.js'
import {
  addPlaylistAccess,
  addVideoToPlaylist,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  getPlaylistAccess,
  removePlaylistAccess,
  removePlaylistItem,
  updatePlaylist,
} from '../api/playlists.js'
import { searchUsers } from '../api/users.js'
import VideoCard from '../components/VideoCard.jsx'
import PlaylistCard from '../components/PlaylistCard.jsx'
import PlaylistQueue from '../components/PlaylistQueue.jsx'
import ChipInput from '../components/ChipInput.jsx'
import './CreatePlaylistPage.css'

const VISIBILITY_OPTIONS = [
  { value: 'public', label: 'Public' },
  { value: 'private', label: 'Private' },
  { value: 'unlisted', label: 'Unlisted' },
  { value: 'hidden', label: 'Hidden' },
]

// Mirrors webapi's USER_PLAYLISTS.title column limit (see
// webapi/lib/models/user-playlist.js) and reuses UploadPage's description
// limit for consistency.
const MAX_TITLE_LENGTH = 255
const MAX_DESCRIPTION_LENGTH = 65535

const RECIPIENT_SEARCH_DEBOUNCE_MS = 300

function recipientLabel(user) {
  return user.displayName ? `${user.displayName} (${user.username})` : user.username
}

function CreatePlaylistPage() {
  const { user, loading: authLoading } = useAuth()
  const { success, error: toastError } = useToast()
  const navigate = useNavigate()
  const { id: playlistId } = useParams()
  const isEditMode = Boolean(playlistId)
  const [searchParams] = useSearchParams()
  const videoId = searchParams.get('videoId')

  const [video, setVideo] = useState(null)
  const [videoLoading, setVideoLoading] = useState(Boolean(videoId))
  const [videoError, setVideoError] = useState(videoId ? null : 'No video specified.')

  const [playlist, setPlaylist] = useState(null)
  const [playlistLoading, setPlaylistLoading] = useState(isEditMode)
  const [playlistError, setPlaylistError] = useState(null)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState('public')

  // A brand-new playlist's creator is always its owner; only edit mode can set these.
  const [viewerIsOwnerOrAdmin, setViewerIsOwnerOrAdmin] = useState(true)
  const [canEditMetadata, setCanEditMetadata] = useState(true)

  const [recipientQuery, setRecipientQuery] = useState('')
  const [recipientSuggestions, setRecipientSuggestions] = useState([])
  const [recipientSearchLoading, setRecipientSearchLoading] = useState(false)
  const [recipients, setRecipients] = useState([])
  const [initialRecipientPermissions, setInitialRecipientPermissions] = useState(new Map())

  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/login')
    }
  }, [authLoading, user, navigate])

  useEffect(() => {
    if (authLoading || !user || isEditMode) {
      return undefined
    }

    if (!videoId) {
      return undefined
    }

    let cancelled = false

    async function load() {
      setVideoLoading(true)
      setVideoError(null)
      try {
        const data = await getVideo(videoId)
        if (!cancelled) {
          setVideo(data)
        }
      } catch {
        if (!cancelled) {
          setVideoError('This video is unavailable right now.')
          toastError('Failed to load this video.')
        }
      } finally {
        if (!cancelled) {
          setVideoLoading(false)
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [authLoading, user, videoId, isEditMode, toastError])

  useEffect(() => {
    if (authLoading || !user || !isEditMode) {
      return undefined
    }

    let cancelled = false

    async function load() {
      setPlaylistLoading(true)
      setPlaylistError(null)
      try {
        const data = await getPlaylist(playlistId)
        if (cancelled) {
          return
        }
        const editAllowed = data.viewerPermission === 'owner' || data.viewerPermission === 'edit'
        if (!editAllowed) {
          setPlaylistError('You don\'t have permission to edit this playlist.')
          toastError('You don\'t have permission to edit this playlist.')
          return
        }
        const isOwnerAdmin = data.viewerPermission === 'owner'
        setViewerIsOwnerOrAdmin(isOwnerAdmin)
        setCanEditMetadata(editAllowed)
        setPlaylist(data)
        setTitle(data.name)
        setDescription(data.description ?? '')
        setVisibility(data.visibility)

        if (isOwnerAdmin && data.visibility === 'private') {
          const { items } = await getPlaylistAccess(playlistId)
          if (!cancelled) {
            setRecipients(
              items.map((item) => ({
                userId: item.userId,
                username: item.username,
                displayName: item.displayName,
                permission: item.permission,
              })),
            )
            setInitialRecipientPermissions(new Map(items.map((item) => [item.userId, item.permission])))
          }
        }
      } catch {
        if (!cancelled) {
          setPlaylistError('This playlist is unavailable right now.')
          toastError('Failed to load this playlist.')
        }
      } finally {
        if (!cancelled) {
          setPlaylistLoading(false)
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [authLoading, user, isEditMode, playlistId, toastError])

  const recipientSearchActive =
    viewerIsOwnerOrAdmin && visibility === 'private' && recipientQuery.trim().length > 0

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

  if (isEditMode) {
    if (playlistLoading) {
      return null
    }

    if (playlistError || !playlist) {
      return (
        <section className="create-playlist-page">
          <div className="create-playlist-card">
            <h1>Edit Playlist</h1>
            <p className="create-playlist-hint">{playlistError ?? 'This playlist is unavailable right now.'}</p>
          </div>
        </section>
      )
    }
  } else {
    if (videoLoading) {
      return null
    }

    if (videoError || !video) {
      return (
        <section className="create-playlist-page">
          <div className="create-playlist-card">
            <h1>New Playlist</h1>
            <p className="create-playlist-hint">{videoError ?? 'This video is unavailable right now.'}</p>
          </div>
        </section>
      )
    }
  }

  const submitDisabled = title.trim().length === 0 || submitting

  async function handleRemoveItem(uploadId) {
    try {
      await removePlaylistItem(playlistId, uploadId)
    } catch {
      toastError('Failed to remove that video. Please try again.')
      return
    }
    setPlaylist((prev) => ({
      ...prev,
      itemCount: prev.itemCount - 1,
      items: prev.items.filter((item) => item.id !== uploadId),
    }))
  }

  async function handleDeletePlaylist() {
    if (deleting) {
      return
    }
    if (!window.confirm(`Delete "${playlist.name}"? This cannot be undone.`)) {
      return
    }

    setDeleting(true)
    try {
      await deletePlaylist(playlistId)
    } catch {
      toastError('Failed to delete the playlist. Please try again.')
      setDeleting(false)
      return
    }

    success('Playlist deleted.')
    navigate('/playlists')
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

  // PLAYLIST_ACCESS has no replace-all endpoint (unlike video access), so
  // syncing means diffing the working recipient list against what was
  // initially loaded and issuing the minimal set of grant/revoke calls.
  async function syncPlaylistAccess(id) {
    const currentByUserId = new Map(recipients.map((r) => [r.userId, r]))
    const toAddOrUpdate = recipients.filter(
      (r) => initialRecipientPermissions.get(r.userId) !== r.permission,
    )
    const toRemove = [...initialRecipientPermissions.keys()].filter(
      (userId) => !currentByUserId.has(userId),
    )
    await Promise.all([
      ...toAddOrUpdate.map((r) => addPlaylistAccess(id, r.username, r.permission)),
      ...toRemove.map((userId) => removePlaylistAccess(id, userId)),
    ])
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (submitDisabled) {
      return
    }

    setSubmitting(true)

    if (isEditMode) {
      const updates = { name: title.trim(), description: description.trim() || null }
      if (viewerIsOwnerOrAdmin) {
        updates.visibility = visibility
      }
      try {
        await updatePlaylist(playlistId, updates)
      } catch {
        toastError('Failed to save changes. Please try again.')
        setSubmitting(false)
        return
      }

      if (viewerIsOwnerOrAdmin && visibility === 'private') {
        try {
          await syncPlaylistAccess(playlistId)
        } catch {
          toastError(
            'Your changes were saved, but sharing with specific users failed. ' +
              'You can manage access from this page.',
          )
          setSubmitting(false)
          return
        }
      }

      setSubmitting(false)
      success('Playlist updated.')
      navigate(-1)
      return
    }

    let created
    try {
      created = await createPlaylist({
        name: title.trim(),
        description: description.trim() || null,
        visibility,
      })
    } catch {
      toastError('Failed to create the playlist. Please try again.')
      setSubmitting(false)
      return
    }

    try {
      await addVideoToPlaylist(created.id, video.id)
    } catch {
      toastError(
        'The playlist was created, but this video could not be added to it. ' +
          'You can add it from the video\'s menu instead.',
      )
      setSubmitting(false)
      return
    }

    if (visibility === 'private' && recipients.length > 0) {
      try {
        await syncPlaylistAccess(created.id)
      } catch {
        toastError(
          'The playlist was created, but sharing with specific users failed. ' +
            'You can manage access from your profile.',
        )
        setSubmitting(false)
        return
      }
    }

    setSubmitting(false)
    success('Playlist created.')
    navigate(-1)
  }

  const playlistCardView = playlist && {
    ...playlist,
    thumbnails: playlist.items.slice(0, 3).map((item) => item.thumbnailUrl).filter(Boolean),
    latestVideoId: playlist.items[0]?.videoId ?? null,
  }

  const form = (
    <form className="create-playlist-card" onSubmit={handleSubmit}>
      <h1>{isEditMode ? 'Edit Playlist' : 'New Playlist'}</h1>

      {isEditMode ? (
        <PlaylistCard playlist={playlistCardView} />
      ) : (
        <VideoCard video={video} orientation="horizontal" hideMenu />
      )}

      <label htmlFor="create-playlist-title">Title</label>
      <input
        id="create-playlist-title"
        type="text"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        maxLength={MAX_TITLE_LENGTH}
        required
      />

      <label htmlFor="create-playlist-description">Description</label>
      <textarea
        id="create-playlist-description"
        rows={3}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        maxLength={MAX_DESCRIPTION_LENGTH}
      />

      <label htmlFor="create-playlist-visibility">Visibility</label>
      <select
        id="create-playlist-visibility"
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
        <p className="create-playlist-hint">Only the owner or an admin can change visibility.</p>
      )}

      {viewerIsOwnerOrAdmin && visibility === 'private' && (
        <>
          <label>Share with</label>
          <ChipInput
            chips={recipients.map((r) => ({ key: String(r.userId), label: recipientLabel(r) }))}
            onRemove={removeRecipient}
            inputValue={recipientQuery}
            onInputChange={setRecipientQuery}
            suggestions={
              recipientSearchActive
                ? recipientSuggestions.map((s) => ({ key: String(s.userId), label: recipientLabel(s) }))
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
        </>
      )}

      <button type="submit" className="create-playlist-submit" disabled={submitDisabled}>
        {submitting ? 'Saving...' : isEditMode ? 'Save Changes' : 'Create Playlist'}
      </button>

      {isEditMode && viewerIsOwnerOrAdmin && (
        <button
          type="button"
          className="create-playlist-delete"
          disabled={deleting}
          onClick={handleDeletePlaylist}
        >
          {deleting ? 'Deleting...' : 'Delete Playlist'}
        </button>
      )}
    </form>
  )

  return (
    <section className="create-playlist-page">
      {isEditMode ? (
        <div className="create-playlist-edit-layout">
          {form}
          <PlaylistQueue playlist={playlist} editable={canEditMetadata} onRemoveItem={handleRemoveItem} />
        </div>
      ) : (
        form
      )}
    </section>
  )
}

export default CreatePlaylistPage
