import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Pencil, UserRound, MailCheck, MailWarning, Video, VideoOff } from 'lucide-react'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import apiClient from '../api/client.js'
import { resendVerification, changePassword } from '../api/auth.js'
import { getMySettings, updateMySettings } from '../api/me.js'
import {
  updateUserAvatar,
  deleteUserAvatar,
  updateUserBanner,
  deleteUserBanner,
} from '../api/users.js'
import NotificationSettings from '../components/NotificationSettings.jsx'
import './AccountSettings.css'

const MIN_PASSWORD_LENGTH = 8

function AccountSettings() {
  const { user: authUser, loading: authLoading, refreshUser } = useAuth()
  const { success, error: toastError } = useToast()
  const navigate = useNavigate()
  const location = useLocation()
  const bannerFileInputRef = useRef(null)
  const avatarFileInputRef = useRef(null)

  const [settings, setSettings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const [username, setUsername] = useState('')
  const [bio, setBio] = useState('')
  const [email, setEmail] = useState('')
  const [savingAccount, setSavingAccount] = useState(false)

  const [bannerUploading, setBannerUploading] = useState(false)
  const [avatarUploading, setAvatarUploading] = useState(false)

  const [resendingVerification, setResendingVerification] = useState(false)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmNewPassword, setConfirmNewPassword] = useState('')
  const [changingPassword, setChangingPassword] = useState(false)

  useEffect(() => {
    if (!authLoading && !authUser) {
      navigate('/login')
    }
  }, [authLoading, authUser, navigate])

  useEffect(() => {
    if (authLoading || !authUser) {
      return undefined
    }

    let cancelled = false

    async function load() {
      setLoading(true)
      setLoadError(null)
      try {
        const data = await getMySettings()
        if (!cancelled) {
          setSettings(data)
          setUsername(data.username)
          setBio(data.bio || '')
          setEmail(data.email)
        }
      } catch {
        if (!cancelled) {
          setLoadError('Account settings are unavailable right now.')
          toastError('Failed to load account settings.')
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
  }, [authLoading, authUser, toastError])

  useEffect(() => {
    if (loading || !location.hash) {
      return
    }
    const target = document.querySelector(location.hash)
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [loading, location.hash])

  async function handleSaveAccount(event) {
    event.preventDefault()
    setSavingAccount(true)
    try {
      // Only send fields that actually changed - re-submitting an unchanged
      // value (e.g. a legacy email that predates format validation) shouldn't
      // trip validation on a field the user never touched.
      const changes = {}
      if (username !== settings.username) {
        changes.username = username
      }
      if (bio !== (settings.bio || '')) {
        changes.bio = bio
      }
      if (email !== settings.email) {
        changes.email = email
      }
      if (Object.keys(changes).length === 0) {
        success('Nothing to save.')
        return
      }

      const updated = await updateMySettings(changes)
      setSettings((prev) => ({ ...prev, ...updated }))
      setUsername(updated.username)
      setBio(updated.bio || '')
      setEmail(updated.email)
      await refreshUser()
      success('Account settings saved.')
    } catch (err) {
      const code = err.response?.data?.error
      const message =
        code === 'conflict'
          ? (err.response?.data?.message || 'Username or email already in use.')
          : (err.response?.data?.message || 'Failed to save account settings.')
      toastError(message)
    } finally {
      setSavingAccount(false)
    }
  }

  async function handleAvatarFileChange(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !settings) {
      return
    }
    setAvatarUploading(true)
    try {
      const { avatarFilename } = await updateUserAvatar(settings.id, file)
      setSettings((prev) => ({ ...prev, avatarFilename }))
      await refreshUser()
      success('Avatar updated.')
    } catch {
      toastError('Failed to upload avatar.')
    } finally {
      setAvatarUploading(false)
    }
  }

  async function handleAvatarDelete() {
    if (!settings) {
      return
    }
    setAvatarUploading(true)
    try {
      await deleteUserAvatar(settings.id)
      setSettings((prev) => ({ ...prev, avatarFilename: null }))
      await refreshUser()
      success('Avatar removed.')
    } catch {
      toastError('Failed to remove avatar.')
    } finally {
      setAvatarUploading(false)
    }
  }

  async function handleBannerFileChange(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !settings) {
      return
    }
    setBannerUploading(true)
    try {
      const { bannerFilename } = await updateUserBanner(settings.id, file)
      setSettings((prev) => ({ ...prev, bannerFilename }))
      success('Banner updated.')
    } catch {
      toastError('Failed to upload banner.')
    } finally {
      setBannerUploading(false)
    }
  }

  async function handleBannerDelete() {
    if (!settings) {
      return
    }
    setBannerUploading(true)
    try {
      await deleteUserBanner(settings.id)
      setSettings((prev) => ({ ...prev, bannerFilename: null }))
      success('Banner removed.')
    } catch {
      toastError('Failed to remove banner.')
    } finally {
      setBannerUploading(false)
    }
  }

  async function handleResendVerification() {
    setResendingVerification(true)
    try {
      await resendVerification()
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

  async function handleChangePassword(event) {
    event.preventDefault()

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      toastError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (newPassword !== confirmNewPassword) {
      toastError('New passwords do not match.')
      return
    }

    setChangingPassword(true)
    try {
      await changePassword(currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmNewPassword('')
      success('Password changed.')
    } catch (err) {
      const message =
        err.response?.status === 401
          ? 'Current password is incorrect.'
          : 'Failed to change password.'
      toastError(message)
    } finally {
      setChangingPassword(false)
    }
  }

  if (authLoading || !authUser) {
    return null
  }

  if (loading) {
    return (
      <section className="settings-page">
        <p className="settings-status">Loading...</p>
      </section>
    )
  }

  if (loadError || !settings) {
    return (
      <section className="settings-page">
        <p className="settings-status">{loadError || 'Account settings are unavailable right now.'}</p>
      </section>
    )
  }

  const avatarUrl = settings.avatarFilename
    ? `${apiClient.defaults.baseURL}/api/v1/users/${settings.username}/avatar`
    : null
  const bannerUrl = settings.bannerFilename
    ? `${apiClient.defaults.baseURL}/api/v1/users/${settings.username}/banner`
    : null

  return (
    <section className="settings-page">
      <div className="settings-columns">
      <div className="settings-card">
        <h1>Account Settings</h1>

        <div
          className="settings-banner"
          style={bannerUrl ? { backgroundImage: `url(${bannerUrl})` } : undefined}
        >
          <div className="settings-banner-actions">
            <button
              type="button"
              className="settings-banner-edit"
              onClick={() => bannerFileInputRef.current?.click()}
              disabled={bannerUploading}
              aria-label="Change banner image"
              title="Change banner image"
            >
              <Pencil size={14} />
            </button>
            {bannerUrl && (
              <button
                type="button"
                className="settings-banner-remove"
                onClick={handleBannerDelete}
                disabled={bannerUploading}
              >
                Remove
              </button>
            )}
            <input
              ref={bannerFileInputRef}
              type="file"
              accept="image/*"
              className="settings-file-input"
              onChange={handleBannerFileChange}
            />
          </div>

          <div className="settings-avatar-wrap">
            {avatarUrl ? (
              <img className="settings-avatar" src={avatarUrl} alt="" />
            ) : (
              <span className="settings-avatar settings-avatar-placeholder">
                <UserRound size={40} />
              </span>
            )}
            <button
              type="button"
              className="settings-avatar-edit"
              onClick={() => avatarFileInputRef.current?.click()}
              disabled={avatarUploading}
              aria-label="Change avatar image"
              title="Change avatar image"
            >
              <Pencil size={12} />
            </button>
            <input
              ref={avatarFileInputRef}
              type="file"
              accept="image/*"
              className="settings-file-input"
              onChange={handleAvatarFileChange}
            />
          </div>
          {avatarUrl && (
            <button
              type="button"
              className="settings-avatar-remove"
              onClick={handleAvatarDelete}
              disabled={avatarUploading}
            >
              Remove avatar
            </button>
          )}
        </div>

        <div className="settings-status-row">
          <span className="settings-status-item">
            {settings.emailVerified ? (
              <MailCheck className="settings-status-icon-true" size={18} />
            ) : (
              <MailWarning className="settings-status-icon-false" size={18} />
            )}
            {settings.emailVerified ? 'Email verified' : 'Email not verified'}
          </span>
          <span className="settings-status-item">
            {settings.uploader ? (
              <Video className="settings-status-icon-true" size={18} />
            ) : (
              <VideoOff className="settings-status-icon-false" size={18} />
            )}
            {settings.uploader ? 'Uploader access granted' : 'No uploader access'}
          </span>
        </div>

        {!settings.emailVerified && (
          <div className="settings-verification-row">
            <button
              type="button"
              className="settings-secondary-button"
              onClick={handleResendVerification}
              disabled={resendingVerification}
            >
              {resendingVerification ? 'Sending...' : 'Resend verification email'}
            </button>
          </div>
        )}

        <form className="settings-form" onSubmit={handleSaveAccount}>
          <label htmlFor="settings-username">Username</label>
          <input
            id="settings-username"
            type="text"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />

          <label htmlFor="settings-bio">Bio</label>
          <textarea
            id="settings-bio"
            rows={3}
            value={bio}
            onChange={(event) => setBio(event.target.value)}
          />

          <label htmlFor="settings-email">Email</label>
          <input
            id="settings-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />

          <button type="submit" className="settings-submit" disabled={savingAccount}>
            {savingAccount ? 'Saving...' : 'Save changes'}
          </button>
        </form>

        <hr className="settings-divider" />

        <form className="settings-form" onSubmit={handleChangePassword}>
          <h2>Change Password</h2>

          <label htmlFor="settings-current-password">Current password</label>
          <input
            id="settings-current-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
          />

          <label htmlFor="settings-new-password">New password</label>
          <input
            id="settings-new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            required
          />

          <label htmlFor="settings-confirm-password">Confirm new password</label>
          <input
            id="settings-confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirmNewPassword}
            onChange={(event) => setConfirmNewPassword(event.target.value)}
            required
          />

          <button type="submit" className="settings-submit" disabled={changingPassword}>
            {changingPassword ? 'Changing...' : 'Change password'}
          </button>
        </form>
      </div>

      <NotificationSettings />
      </div>
    </section>
  )
}

export default AccountSettings
