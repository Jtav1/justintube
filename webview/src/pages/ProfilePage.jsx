import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowRight, Pencil, UserRound } from 'lucide-react'
import { useAuth } from '../context/useAuth.js'
import apiClient from '../api/client.js'
import { resendVerification } from '../api/auth.js'
import {
  getUserChannel,
  updateUserProfile,
  updateUserBanner,
  deleteUserBanner,
  updateUserAvatar,
  adminResendUserVerification,
  adminGrantUploader,
} from '../api/users.js'
import { listUserPlaylists } from '../api/playlists.js'
import VideoCard from '../components/VideoCard.jsx'
import PlaylistCard from '../components/PlaylistCard.jsx'
import './ProfilePage.css'

const PAGE_LIMIT = 24
const PLAYLISTS_LIMIT = 25

// Must match .profile-playlists-grid's grid-template-columns/gap in
// ProfilePage.css (repeat(auto-fill, minmax(PLAYLISTS_MIN_CARD_WIDTH, 1fr)),
// gap: PLAYLISTS_GRID_GAP), so the row can be trimmed to exactly what fits.
const PLAYLISTS_MIN_CARD_WIDTH = 180
const PLAYLISTS_GRID_GAP = 10

const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'views', label: 'Most viewed' },
]

function ProfilePage() {
  const { username } = useParams()
  const { user: authUser } = useAuth()
  const fileInputRef = useRef(null)
  const avatarFileInputRef = useRef(null)

  const [profile, setProfile] = useState(null)
  const [sort, setSort] = useState('newest')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [playlists, setPlaylists] = useState(null)
  // Starts at Infinity (not 1) so nothing is trimmed before the grid has
  // mounted and been measured - the grid only renders once visiblePlaylists
  // is non-empty, so an initial column count of 1 would trim every playlist
  // away and the ref (needed to measure and correct it) would never attach.
  const [playlistsColumns, setPlaylistsColumns] = useState(Infinity)
  const playlistsGridRef = useRef(null)
  const [bannerUploading, setBannerUploading] = useState(false)
  const [avatarUploading, setAvatarUploading] = useState(false)

  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [editingBio, setEditingBio] = useState(false)
  const [bioDraft, setBioDraft] = useState('')
  const [savingField, setSavingField] = useState(false)
  const [fieldError, setFieldError] = useState(null)

  const [resendingVerification, setResendingVerification] = useState(false)
  const [resendStatus, setResendStatus] = useState(null)

  const [grantingUploader, setGrantingUploader] = useState(false)
  const [grantUploaderStatus, setGrantUploaderStatus] = useState(null)

  const resetKeyRef = useRef(null)

  useEffect(() => {
    let cancelled = false

    const resetKey = `${username}|${sort}`
    const isReset = resetKeyRef.current !== resetKey
    if (isReset && page !== 1) {
      resetKeyRef.current = resetKey
      setPage(1)
      return undefined
    }
    resetKeyRef.current = resetKey

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const data = await getUserChannel(username, { page, limit: PAGE_LIMIT, sort })
        if (!cancelled) {
          setProfile((prev) => ({
            user: data.user,
            videos: {
              ...data.videos,
              items:
                page === 1 || !prev
                  ? data.videos.items
                  : [...prev.videos.items, ...data.videos.items],
            },
          }))
        }
      } catch {
        if (!cancelled) {
          setError('Failed to load profile.')
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
  }, [username, sort, page])

  useEffect(() => {
    let cancelled = false

    async function loadPlaylists() {
      try {
        const data = await listUserPlaylists(username, { limit: PLAYLISTS_LIMIT })
        if (!cancelled) {
          setPlaylists(data.items)
        }
      } catch {
        if (!cancelled) {
          setPlaylists([])
        }
      }
    }

    loadPlaylists()

    return () => {
      cancelled = true
    }
  }, [username])

  useEffect(() => {
    const el = playlistsGridRef.current
    if (!el) {
      return undefined
    }

    function measure() {
      const columns = Math.max(
        1,
        Math.floor(
          (el.clientWidth + PLAYLISTS_GRID_GAP) / (PLAYLISTS_MIN_CARD_WIDTH + PLAYLISTS_GRID_GAP),
        ),
      )
      setPlaylistsColumns(columns)
    }

    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [playlists])

  const isOwnProfile = Boolean(authUser && authUser.username === username)
  const isAdminViewer = Boolean(authUser && authUser.role === 'admin')
  const canManageProfile = Boolean(
    authUser && (isOwnProfile || authUser.role === 'admin' || authUser.role === 'moderator'),
  )
  const canResendVerification = Boolean(
    (isOwnProfile || isAdminViewer) && profile?.user?.emailVerified === false,
  )
  const canGrantUploader = Boolean(isAdminViewer && profile?.user?.uploader === false)

  async function handleResendVerification() {
    setResendingVerification(true)
    setResendStatus(null)
    try {
      if (isOwnProfile) {
        await resendVerification()
      } else {
        await adminResendUserVerification(profile.user.id)
      }
      setResendStatus({ type: 'success', message: 'Verification email sent.' })
    } catch (err) {
      const code = err.response?.data?.error
      const message =
        code === 'email_disabled'
          ? 'Email sending is not configured on this server.'
          : code === 'already_verified'
            ? 'This account is already verified.'
            : 'Failed to send verification email.'
      setResendStatus({ type: 'error', message })
    } finally {
      setResendingVerification(false)
    }
  }

  async function handleGrantUploader() {
    setGrantingUploader(true)
    setGrantUploaderStatus(null)
    try {
      await adminGrantUploader(profile.user.id)
      setProfile((prev) => ({ ...prev, user: { ...prev.user, uploader: true } }))
      setGrantUploaderStatus({ type: 'success', message: 'Uploader access granted.' })
    } catch {
      setGrantUploaderStatus({ type: 'error', message: 'Failed to grant uploader access.' })
    } finally {
      setGrantingUploader(false)
    }
  }

  function startEditName() {
    setNameDraft(profile.user.displayName || '')
    setFieldError(null)
    setEditingName(true)
  }

  function startEditBio() {
    setBioDraft(profile.user.bio || '')
    setFieldError(null)
    setEditingBio(true)
  }

  async function saveField(field, value) {
    setSavingField(true)
    setFieldError(null)
    try {
      const updated = await updateUserProfile(profile.user.id, { [field]: value })
      setProfile((prev) => ({
        ...prev,
        user: { ...prev.user, displayName: updated.displayName, bio: updated.bio },
      }))
      setEditingName(false)
      setEditingBio(false)
    } catch {
      setFieldError('Failed to save changes.')
    } finally {
      setSavingField(false)
    }
  }

  async function handleAvatarFileChange(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !profile) {
      return
    }
    setAvatarUploading(true)
    try {
      const { avatarFilename } = await updateUserAvatar(profile.user.id, file)
      setProfile((prev) => ({ ...prev, user: { ...prev.user, avatarFilename } }))
    } catch {
      setError('Failed to upload avatar.')
    } finally {
      setAvatarUploading(false)
    }
  }

  async function handleBannerFileChange(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !profile) {
      return
    }
    setBannerUploading(true)
    try {
      const { bannerFilename } = await updateUserBanner(profile.user.id, file)
      setProfile((prev) => ({ ...prev, user: { ...prev.user, bannerFilename } }))
    } catch {
      setError('Failed to upload banner.')
    } finally {
      setBannerUploading(false)
    }
  }

  async function handleBannerDelete() {
    if (!profile) {
      return
    }
    setBannerUploading(true)
    try {
      await deleteUserBanner(profile.user.id)
      setProfile((prev) => ({ ...prev, user: { ...prev.user, bannerFilename: null } }))
    } catch {
      setError('Failed to remove banner.')
    } finally {
      setBannerUploading(false)
    }
  }

  function handleSortChange(event) {
    setSort(event.target.value)
  }

  if (loading && !profile) {
    return <p className="profile-status">Loading...</p>
  }

  if (error && !profile) {
    return <p className="profile-status profile-status-error">{error}</p>
  }

  if (!profile) {
    return null
  }

  const { user, videos } = profile
  const avatarUrl = user.avatarFilename
    ? `${apiClient.defaults.baseURL}/api/v1/users/${user.username}/avatar`
    : null
  const bannerUrl = user.bannerFilename
    ? `${apiClient.defaults.baseURL}/api/v1/users/${user.username}/banner`
    : null

  const playlistsOverflowing = Boolean(playlists) && playlists.length > playlistsColumns
  const visiblePlaylists = playlistsOverflowing
    ? playlists.slice(0, Math.max(playlistsColumns - 1, 0))
    : playlists ?? []

  return (
    <section className="profile-page">
      <div
        className="profile-banner"
        style={bannerUrl ? { backgroundImage: `url(${bannerUrl})` } : undefined}
      >
        {canManageProfile && (
          <div className="profile-banner-actions">
            <button
              type="button"
              className="profile-banner-edit"
              onClick={() => fileInputRef.current?.click()}
              disabled={bannerUploading}
              aria-label="Change banner image"
            >
              <Pencil size={16} />
            </button>
            {bannerUrl && (
              <button
                type="button"
                className="profile-banner-remove"
                onClick={handleBannerDelete}
                disabled={bannerUploading}
              >
                Remove
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="profile-banner-file-input"
              onChange={handleBannerFileChange}
            />
          </div>
        )}

        <div className="profile-avatar-wrap">
          {avatarUrl ? (
            <img className="profile-avatar" src={avatarUrl} alt="" />
          ) : (
            <span className="profile-avatar profile-avatar-placeholder">
              <UserRound size={120} />
            </span>
          )}
          {canManageProfile && (
            <>
              <button
                type="button"
                className="profile-avatar-edit"
                onClick={() => avatarFileInputRef.current?.click()}
                disabled={avatarUploading}
                aria-label="Change avatar image"
              >
                <Pencil size={14} />
              </button>
              <input
                ref={avatarFileInputRef}
                type="file"
                accept="image/*"
                className="profile-banner-file-input"
                onChange={handleAvatarFileChange}
              />
            </>
          )}
        </div>

        <div className="profile-name-row">
          {editingName ? (
            <form
              className="profile-inline-edit"
              onSubmit={(event) => {
                event.preventDefault()
                saveField('displayName', nameDraft)
              }}
            >
              <input
                type="text"
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                autoFocus
              />
              <button type="submit" disabled={savingField}>
                Save
              </button>
              <button type="button" onClick={() => setEditingName(false)} disabled={savingField}>
                Cancel
              </button>
            </form>
          ) : (
            <>
              <h1 className="profile-username">
                {user.displayName || user.username}
                {user.displayName && (
                  <span className="profile-username-handle"> ({user.username})</span>
                )}
                {user.role && <span className="profile-username-role"> - role: {user.role}</span>}
              </h1>
              {canManageProfile && (
                <button
                  type="button"
                  className="profile-edit-icon"
                  onClick={startEditName}
                  aria-label="Edit name"
                >
                  <Pencil size={18} />
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="profile-bio-row">
        {editingBio ? (
          <form
            className="profile-inline-edit profile-inline-edit-bio"
            onSubmit={(event) => {
              event.preventDefault()
              saveField('bio', bioDraft)
            }}
          >
            <textarea
              value={bioDraft}
              onChange={(event) => setBioDraft(event.target.value)}
              rows={3}
              autoFocus
            />
            <div className="profile-inline-edit-actions">
              <button type="submit" disabled={savingField}>
                Save
              </button>
              <button type="button" onClick={() => setEditingBio(false)} disabled={savingField}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            <p className="profile-bio">
              {user.bio || <em>No bio yet.</em>}
            </p>
            {canManageProfile && (
              <button
                type="button"
                className="profile-edit-icon"
                onClick={startEditBio}
                aria-label="Edit bio"
              >
                <Pencil size={18} />
              </button>
            )}
          </>
        )}
      </div>

      {fieldError && <p className="profile-status profile-status-error">{fieldError}</p>}

      {canResendVerification && (
        <div className="profile-verification-row">
          <button
            type="button"
            className="profile-resend-verification"
            onClick={handleResendVerification}
            disabled={resendingVerification}
          >
            {resendingVerification ? 'Sending...' : 'Resend verification email'}
          </button>
          {resendStatus && (
            <p
              className={
                resendStatus.type === 'error'
                  ? 'profile-status profile-status-error'
                  : 'profile-status'
              }
            >
              {resendStatus.message}
            </p>
          )}
        </div>
      )}

      {canGrantUploader && (
        <div className="profile-verification-row">
          <button
            type="button"
            className="profile-resend-verification"
            onClick={handleGrantUploader}
            disabled={grantingUploader}
          >
            {grantingUploader ? 'Granting...' : 'Grant uploader access'}
          </button>
          {grantUploaderStatus && (
            <p
              className={
                grantUploaderStatus.type === 'error'
                  ? 'profile-status profile-status-error'
                  : 'profile-status'
              }
            >
              {grantUploaderStatus.message}
            </p>
          )}
        </div>
      )}

      {visiblePlaylists.length > 0 && (
        <div className="profile-section">
          <h2 className="profile-section-title">Playlists</h2>
          <div className="profile-playlists-grid" ref={playlistsGridRef}>
            {visiblePlaylists.map((playlist) => (
              <PlaylistCard key={playlist.id} playlist={playlist} />
            ))}
            {playlistsOverflowing && (
              <Link to={`/users/${username}/playlists`} className="profile-playlists-more">
                <span className="profile-playlists-more-thumb">
                  <span className="profile-playlists-more-circle">
                    <ArrowRight size={28} />
                  </span>
                </span>
                <span className="profile-playlists-more-label">More...</span>
              </Link>
            )}
          </div>
        </div>
      )}

      <div className="profile-videos-header">
        {visiblePlaylists.length > 0 && (
          <h2 className="profile-section-title profile-videos-title">All Videos</h2>
        )}
        <label className="profile-sort">
          Sort by
          <select value={sort} onChange={handleSortChange}>
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="profile-status profile-status-error">{error}</p>}
      {!loading && videos.items.length === 0 && !error && (
        <p className="profile-status">No videos yet.</p>
      )}
      <div className="profile-videos-grid">
        {videos.items.map((video) => (
          <VideoCard key={video.id} video={video} />
        ))}
      </div>
      {page < videos.totalPages && (
        <button
          type="button"
          className="profile-load-more"
          disabled={loading}
          onClick={() => setPage((prev) => prev + 1)}
        >
          {loading ? 'Loading...' : 'Load more'}
        </button>
      )}
    </section>
  )
}

export default ProfilePage
