import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/useAuth.js'
import { getVideo } from '../api/videos.js'
import { addVideoToPlaylist, createPlaylist } from '../api/playlists.js'
import VideoCard from '../components/VideoCard.jsx'
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
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const videoId = searchParams.get('videoId')

  const [video, setVideo] = useState(null)
  const [videoLoading, setVideoLoading] = useState(Boolean(videoId))
  const [videoError, setVideoError] = useState(videoId ? null : 'No video specified.')

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState('public')

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/login')
    }
  }, [authLoading, user, navigate])

  useEffect(() => {
    if (authLoading || !user) {
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
          setVideoError('Failed to load this video.')
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
  }, [authLoading, user, videoId])

  if (authLoading || !user) {
    return null
  }

  if (videoLoading) {
    return null
  }

  if (videoError || !video) {
    return (
      <section className="create-playlist-page">
        <div className="create-playlist-card">
          <h1>New Playlist</h1>
          <p className="create-playlist-error">{videoError ?? 'Video not found.'}</p>
        </div>
      </section>
    )
  }

  const submitDisabled = title.trim().length === 0 || submitting

  async function handleSubmit(event) {
    event.preventDefault()
    if (submitDisabled) {
      return
    }

    setSubmitting(true)
    setSubmitError(null)

    let created
    try {
      created = await createPlaylist({
        name: title.trim(),
        description: description.trim() || null,
        visibility,
      })
    } catch {
      setSubmitError('Failed to create the playlist. Please try again.')
      setSubmitting(false)
      return
    }

    try {
      await addVideoToPlaylist(created.id, video.id)
    } catch {
      setSubmitError(
        'The playlist was created, but this video could not be added to it. ' +
          'You can add it from the video\'s menu instead.',
      )
      setSubmitting(false)
      return
    }

    setSubmitting(false)
    navigate(-1)
  }

  return (
    <section className="create-playlist-page">
      <form className="create-playlist-card" onSubmit={handleSubmit}>
        <h1>New Playlist</h1>

        <VideoCard video={video} orientation="horizontal" hideMenu />

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

        {submitError && <p className="create-playlist-error">{submitError}</p>}

        <button type="submit" className="create-playlist-submit" disabled={submitDisabled}>
          {submitting ? 'Creating...' : 'Create Playlist'}
        </button>
      </form>
    </section>
  )
}

export default CreatePlaylistPage
