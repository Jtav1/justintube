import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowDownWideNarrow,
  ArrowRight,
  Funnel,
  Pencil,
  UserRound,
} from 'lucide-react'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import { useInfiniteScroll } from '../hooks/useInfiniteScroll.js'
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
  adminUpdateUserRole,
  adminResetUserPassword,
  getSubscriptionState,
  subscribeToUser,
  unsubscribeFromUser,
} from '../api/users.js'
import { listUserPlaylists } from '../api/playlists.js'
import { USER_ROLES } from '../lib/roles.js'
import { VISIBILITY_OPTIONS } from '../constants/visibility.js'
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
  { value: 'views_asc', label: 'Least viewed' },
  { value: 'likes', label: 'Most liked' },
  { value: 'likes_asc', label: 'Least liked' },
]

// Order matches VISIBILITY_OPTIONS (Public, Private, Unlisted, Hidden) with
// "All" appended last - the dropdown still defaults to "all" via the
// visibilityFilter state below, independent of list order.
const FILTER_OPTIONS = [...VISIBILITY_OPTIONS, { value: 'all', label: 'All' }]

function ProfilePage() {
  const { username } = useParams()
  const { user: authUser } = useAuth()
  const { success, error: toastError } = useToast()
  const fileInputRef = useRef(null)
  const avatarFileInputRef = useRef(null)

  const [profile, setProfile] = useState(null)
  const [sort, setSort] = useState('newest')
  // Client-side only (filters the already-loaded page of videos) - never
  // persisted, and always resets to "all" on navigating to a new profile
  // since it's plain component state.
  const [visibilityFilter, setVisibilityFilter] = useState('all')
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
  const [subscribed, setSubscribed] = useState(null)
  const [subscribePending, setSubscribePending] = useState(false)

  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [editingBio, setEditingBio] = useState(false)
  const [bioDraft, setBioDraft] = useState('')
  const [savingField, setSavingField] = useState(false)

  const [resendingVerification, setResendingVerification] = useState(false)

  const [grantingUploader, setGrantingUploader] = useState(false)

  const [updatingRole, setUpdatingRole] = useState(false)

  const [resettingPassword, setResettingPassword] = useState(false)
  const [newAdminPassword, setNewAdminPassword] = useState('')
  const [savingAdminPassword, setSavingAdminPassword] = useState(false)

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
          const message = page === 1 ? 'Failed to load profile.' : 'Failed to load more videos.'
          setError(message)
          toastError(message)
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
  }, [username, sort, page, toastError])

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

  useEffect(() => {
    let cancelled = false
    setSubscribed(null)

    const targetId = profile?.user?.id
    if (!authUser || targetId == null || authUser.username === username) {
      return undefined
    }

    getSubscriptionState(targetId)
      .then((data) => {
        if (!cancelled) {
          setSubscribed(data.subscribed)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSubscribed(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [authUser, profile?.user?.id, username])

  const isOwnProfile = Boolean(authUser && authUser.username === username)
  const isAdminViewer = Boolean(authUser && authUser.role === 'admin')
  const canManageProfile = Boolean(
    authUser && (isOwnProfile || authUser.role === 'admin' || authUser.role === 'moderator'),
  )
  const canResendVerification = Boolean(
    (isOwnProfile || isAdminViewer) && profile?.user?.emailVerified === false,
  )
  const canGrantUploader = Boolean(isAdminViewer && profile?.user?.uploader === false)
  const canSubscribe = Boolean(authUser) && !isOwnProfile && profile?.user?.id != null

  async function handleResendVerification() {
    setResendingVerification(true)
    try {
      if (isOwnProfile) {
        await resendVerification()
      } else {
        await adminResendUserVerification(profile.user.id)
      }
      success('Verification email sent.')
    } catch (err) {
      const code = err.response?.data?.error
      const message =
        code === 'email_disabled'
          ? 'Email sending is not configured on this server.'
          : code === 'already_verified'
            ? 'This account is already verified.'
            : 'Failed to send verification email.'
      toastError(message)
    } finally {
      setResendingVerification(false)
    }
  }

  async function handleGrantUploader() {
    setGrantingUploader(true)
    try {
      await adminGrantUploader(profile.user.id)
      setProfile((prev) => ({ ...prev, user: { ...prev.user, uploader: true } }))
      success('Uploader access granted.')
    } catch {
      toastError('Failed to grant uploader access.')
    } finally {
      setGrantingUploader(false)
    }
  }

  async function handleToggleSubscribe() {
    if (subscribePending || subscribed === null) {
      return
    }
    setSubscribePending(true)
    try {
      const result = subscribed
        ? await unsubscribeFromUser(profile.user.id)
        : await subscribeToUser(profile.user.id)
      setSubscribed(result.subscribed)
    } catch (err) {
      console.error('Failed to update subscription:', err)
      toastError('Failed to update subscription.')
    } finally {
      setSubscribePending(false)
    }
  }

  async function handleRoleChange(role) {
    setUpdatingRole(true)
    try {
      const updated = await adminUpdateUserRole(profile.user.id, role)
      setProfile((prev) => ({ ...prev, user: { ...prev.user, role: updated.role } }))
      success('Role updated.')
    } catch {
      toastError('Failed to update role.')
    } finally {
      setUpdatingRole(false)
    }
  }

  async function handleAdminResetPassword(event) {
    event.preventDefault()
    if (newAdminPassword.length < 8) {
      toastError('Password must be at least 8 characters.')
      return
    }

    setSavingAdminPassword(true)
    try {
      await adminResetUserPassword(profile.user.id, newAdminPassword)
      setResettingPassword(false)
      setNewAdminPassword('')
      success('Password reset. The user must set a new password on next login.')
    } catch {
      toastError('Failed to reset password.')
    } finally {
      setSavingAdminPassword(false)
    }
  }

  function startEditName() {
    setNameDraft(profile.user.displayName || '')
    setEditingName(true)
  }

  function startEditBio() {
    setBioDraft(profile.user.bio || '')
    setEditingBio(true)
  }

  async function saveField(field, value) {
    setSavingField(true)
    try {
      const updated = await updateUserProfile(profile.user.id, { [field]: value })
      setProfile((prev) => ({
        ...prev,
        user: { ...prev.user, displayName: updated.displayName, bio: updated.bio },
      }))
      setEditingName(false)
      setEditingBio(false)
      success('Profile updated.')
    } catch {
      toastError('Failed to save changes.')
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
      success('Avatar updated.')
    } catch {
      toastError('Failed to upload avatar.')
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
      success('Banner updated.')
    } catch {
      toastError('Failed to upload banner.')
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
      success('Banner removed.')
    } catch {
      toastError('Failed to remove banner.')
    } finally {
      setBannerUploading(false)
    }
  }

  function handleSortChange(event) {
    setSort(event.target.value)
  }

  function handleVisibilityFilterChange(event) {
    setVisibilityFilter(event.target.value)
  }

  const hasMoreVideos = Boolean(profile) && page < profile.videos.totalPages

  const handleLoadMoreVideos = useCallback(() => {
    setPage((prev) => prev + 1)
  }, [])

  const loadMoreRef = useInfiniteScroll({
    hasMore: hasMoreVideos,
    loading,
    onLoadMore: handleLoadMoreVideos,
  })

  if (loading && !profile) {
    return <p className="profile-status">Loading...</p>
  }

  if (error && !profile) {
    return <p className="profile-status">{error}</p>
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

  const displayedVideos =
    visibilityFilter === 'all'
      ? videos.items
      : videos.items.filter((video) => video.visibility === visibilityFilter)

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
              title="Change banner image"
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
                title="Change avatar image"
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
                {' '}<span className="profile-user-id">User # {user.id}</span>
                {!isAdminViewer && user.role && (
                  <span className="profile-username-role"> - role: {user.role}</span>
                )}
              </h1>
              {isAdminViewer && (
                <label className="profile-role-select">
                  Role
                  <select
                    value={user.role ?? ''}
                    disabled={updatingRole}
                    onChange={(event) => handleRoleChange(event.target.value)}
                  >
                    {USER_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {canManageProfile && (
                <button
                  type="button"
                  className="profile-edit-icon"
                  onClick={startEditName}
                  aria-label="Edit name"
                  title="Edit name"
                >
                  <Pencil size={18} />
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="profile-subscriber-row">
        <p className="profile-subscriber-count">{user.subscriberCount ?? 0} Subscribers</p>
        {canSubscribe && (
          <button
            type="button"
            className={`profile-subscribe-btn${subscribed ? ' profile-subscribe-btn-active' : ''}`}
            disabled={subscribed === null || subscribePending}
            onClick={handleToggleSubscribe}
          >
            {subscribed ? 'Unsubscribe' : 'Subscribe'}
          </button>
        )}
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
                title="Edit bio"
              >
                <Pencil size={18} />
              </button>
            )}
          </>
        )}
      </div>

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
        </div>
      )}

      {isAdminViewer && (
        <div className="profile-verification-row">
          {resettingPassword ? (
            <form className="profile-inline-edit" onSubmit={handleAdminResetPassword}>
              <input
                type="password"
                autoComplete="new-password"
                placeholder="New password"
                minLength={8}
                value={newAdminPassword}
                onChange={(event) => setNewAdminPassword(event.target.value)}
                autoFocus
                required
              />
              <div className="profile-inline-edit-actions">
                <button type="submit" disabled={savingAdminPassword}>
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setResettingPassword(false)
                    setNewAdminPassword('')
                  }}
                  disabled={savingAdminPassword}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              className="profile-resend-verification"
              onClick={() => setResettingPassword(true)}
            >
              Reset password
            </button>
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
          <h2 className="profile-section-title profile-videos-title">
            All Videos ({videos.totalHits} Total)
          </h2>
        )}
        <label className="profile-filter">
          <Funnel size={16} />
          Filter by
          <select value={visibilityFilter} onChange={handleVisibilityFilterChange}>
            {FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="profile-sort">
          <ArrowDownWideNarrow size={16} />
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

      {!loading && displayedVideos.length === 0 && (
        <p className="profile-status">
          {visibilityFilter === 'all' ? 'No videos yet.' : 'No videos match this filter.'}
        </p>
      )}
      <div className="profile-videos-grid">
        {displayedVideos.map((video) => (
          <VideoCard key={video.id} video={video} />
        ))}
      </div>
      {hasMoreVideos && <div className="profile-videos-scroll-sentinel" ref={loadMoreRef} />}
    </section>
  )
}

export default ProfilePage
