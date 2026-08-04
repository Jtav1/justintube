import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import { getVideo } from '../api/videos.js'
import {
  addVideoToPlaylist,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  removePlaylistItem,
  updatePlaylist,
} from '../api/playlists.js'
import VideoCard from '../components/VideoCard.jsx'
import PlaylistCard from '../components/PlaylistCard.jsx'
import PlaylistQueue from '../components/PlaylistQueue.jsx'
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
        const canEdit = String(user.id) === String(data.owner?.id) || user.role === 'admin'
        if (!canEdit) {
          setPlaylistError('You don\'t have permission to edit this playlist.')
          toastError('You don\'t have permission to edit this playlist.')
          return
        }
        setPlaylist(data)
        setTitle(data.name)
        setDescription(data.description ?? '')
        setVisibility(data.visibility)
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

  async function handleSubmit(event) {
    event.preventDefault()
    if (submitDisabled) {
      return
    }

    setSubmitting(true)

    if (isEditMode) {
      try {
        await updatePlaylist(playlistId, {
          name: title.trim(),
          description: description.trim() || null,
          visibility,
        })
      } catch {
        toastError('Failed to save changes. Please try again.')
        setSubmitting(false)
        return
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
      >
        {VISIBILITY_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <button type="submit" className="create-playlist-submit" disabled={submitDisabled}>
        {submitting ? 'Saving...' : isEditMode ? 'Save Changes' : 'Create Playlist'}
      </button>

      {isEditMode && (
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
          <PlaylistQueue playlist={playlist} editable onRemoveItem={handleRemoveItem} />
        </div>
      ) : (
        form
      )}
    </section>
  )
}

export default CreatePlaylistPage
