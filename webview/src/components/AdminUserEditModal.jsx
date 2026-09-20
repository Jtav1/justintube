import { useState } from 'react'
import { MailCheck, MailWarning, Trash2, UserRound, Video, VideoOff } from 'lucide-react'
import { useToast } from '../context/useToast.js'
import apiClient from '../api/client.js'
import {
  adminResetUserPassword,
  adminUpdateUserRole,
  deleteUserAvatar,
  deleteUserBanner,
} from '../api/users.js'
import { USER_ROLES } from '../lib/roles.js'
import Modal from './Modal.jsx'
import './AdminUserEditModal.css'

const MIN_PASSWORD_LENGTH = 8

/**
 * Admin Panel modal for editing a single user: avatar/banner removal, role
 * assignment, and a confirm-gated password reset. Read-only status (email
 * verification, uploader access) mirrors the account settings page; revoking
 * either happens from the users table row, not from here.
 * @param {{ user: object, onClose: () => void, onUpdated: (patch: object) => void }} props
 */
function AdminUserEditModal({ user, onClose, onUpdated }) {
  const { success, error: toastError } = useToast()

  const [avatarFilename, setAvatarFilename] = useState(user.avatarFilename)
  const [bannerFilename, setBannerFilename] = useState(user.bannerFilename)
  const [deletingAvatar, setDeletingAvatar] = useState(false)
  const [deletingBanner, setDeletingBanner] = useState(false)

  const [role, setRole] = useState(user.role)
  const [updatingRole, setUpdatingRole] = useState(false)

  const [resettingPassword, setResettingPassword] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [confirmNewPassword, setConfirmNewPassword] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)

  const label = user.displayName || user.username

  const avatarUrl = avatarFilename
    ? `${apiClient.defaults.baseURL}/api/v1/users/${user.username}/avatar`
    : null
  const bannerUrl = bannerFilename
    ? `${apiClient.defaults.baseURL}/api/v1/users/${user.username}/banner`
    : null

  async function handleDeleteAvatar() {
    setDeletingAvatar(true)
    try {
      await deleteUserAvatar(user.id)
      setAvatarFilename(null)
      onUpdated({ avatarFilename: null })
      success('Avatar removed.')
    } catch {
      toastError('Failed to remove avatar.')
    } finally {
      setDeletingAvatar(false)
    }
  }

  async function handleDeleteBanner() {
    setDeletingBanner(true)
    try {
      await deleteUserBanner(user.id)
      setBannerFilename(null)
      onUpdated({ bannerFilename: null })
      success('Banner removed.')
    } catch {
      toastError('Failed to remove banner.')
    } finally {
      setDeletingBanner(false)
    }
  }

  async function handleRoleChange(event) {
    const nextRole = event.target.value
    const previousRole = role
    setRole(nextRole)
    setUpdatingRole(true)
    try {
      const updated = await adminUpdateUserRole(user.id, nextRole)
      onUpdated({ role: updated.role, uploader: updated.uploader })
      success('Role updated.')
    } catch {
      setRole(previousRole)
      toastError('Failed to update role.')
    } finally {
      setUpdatingRole(false)
    }
  }

  function handleStartResetPassword() {
    if (!window.confirm(`Reset the password for ${label}? They will need to set a new password.`)) {
      return
    }
    setResettingPassword(true)
  }

  function handleCancelResetPassword() {
    setResettingPassword(false)
    setNewPassword('')
    setConfirmNewPassword('')
  }

  async function handleSubmitResetPassword(event) {
    event.preventDefault()
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      toastError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (newPassword !== confirmNewPassword) {
      toastError('New passwords do not match.')
      return
    }

    setSavingPassword(true)
    try {
      await adminResetUserPassword(user.id, newPassword)
      success('Password reset. The user must set a new password on next login.')
      handleCancelResetPassword()
    } catch {
      toastError('Failed to reset password.')
    } finally {
      setSavingPassword(false)
    }
  }

  return (
    <Modal open title={`Edit ${label}`} onClose={onClose}>
      <div
        className="admin-user-edit-banner"
        style={bannerUrl ? { backgroundImage: `url(${bannerUrl})` } : undefined}
      >
        {bannerUrl && (
          <button
            type="button"
            className="admin-user-edit-banner-delete"
            onClick={handleDeleteBanner}
            disabled={deletingBanner}
            aria-label="Delete banner"
            title="Delete banner"
          >
            <Trash2 size={14} />
          </button>
        )}

        <div className="admin-user-edit-avatar-wrap">
          {avatarUrl ? (
            <img className="admin-user-edit-avatar" src={avatarUrl} alt="" />
          ) : (
            <span className="admin-user-edit-avatar admin-user-edit-avatar-placeholder">
              <UserRound size={36} />
            </span>
          )}
          {avatarUrl && (
            <button
              type="button"
              className="admin-user-edit-avatar-delete"
              onClick={handleDeleteAvatar}
              disabled={deletingAvatar}
              aria-label="Delete avatar"
              title="Delete avatar"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="admin-user-edit-status-row">
        <span className="admin-user-edit-status-item">
          {user.emailVerified ? (
            <MailCheck className="admin-user-edit-status-icon-true" size={18} />
          ) : (
            <MailWarning className="admin-user-edit-status-icon-false" size={18} />
          )}
          {user.emailVerified ? 'Email verified' : 'Email not verified'}
        </span>
        <span className="admin-user-edit-status-item">
          {user.uploader ? (
            <Video className="admin-user-edit-status-icon-true" size={18} />
          ) : (
            <VideoOff className="admin-user-edit-status-icon-false" size={18} />
          )}
          {user.uploader ? 'Uploader access granted' : 'No uploader access'}
        </span>
      </div>

      <label className="admin-user-edit-role-label" htmlFor="admin-user-edit-role">
        Role
        <select
          id="admin-user-edit-role"
          value={role ?? ''}
          disabled={updatingRole}
          onChange={handleRoleChange}
        >
          {USER_ROLES.map((roleOption) => (
            <option key={roleOption} value={roleOption}>
              {roleOption}
            </option>
          ))}
        </select>
      </label>

      <hr className="admin-user-edit-divider" />

      {resettingPassword ? (
        <form className="admin-user-edit-password-form" onSubmit={handleSubmitResetPassword}>
          <label htmlFor="admin-user-edit-new-password">New password</label>
          <input
            id="admin-user-edit-new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoFocus
            required
          />
          <label htmlFor="admin-user-edit-confirm-password">Confirm new password</label>
          <input
            id="admin-user-edit-confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirmNewPassword}
            onChange={(event) => setConfirmNewPassword(event.target.value)}
            required
          />
          <div className="admin-user-edit-password-actions">
            <button type="submit" className="admin-user-edit-submit" disabled={savingPassword}>
              {savingPassword ? 'Saving...' : 'Save new password'}
            </button>
            <button
              type="button"
              className="admin-user-edit-cancel"
              onClick={handleCancelResetPassword}
              disabled={savingPassword}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="admin-user-edit-submit" onClick={handleStartResetPassword}>
          Reset password
        </button>
      )}
    </Modal>
  )
}

export default AdminUserEditModal
