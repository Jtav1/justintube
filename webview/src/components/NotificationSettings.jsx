import { useEffect, useState } from 'react'
import {
  getNotificationPreferences,
  updateNotificationPreferences,
} from '../api/notifications.js'
import './NotificationSettings.css'

function NotificationSettings() {
  const [preferences, setPreferences] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [status, setStatus] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setLoadError(null)
      try {
        const data = await getNotificationPreferences()
        if (!cancelled) {
          setPreferences(data.preferences)
        }
      } catch {
        if (!cancelled) {
          setLoadError('Failed to load notification settings.')
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
  }, [])

  async function handleToggle(notificationType, field, value) {
    setStatus(null)
    setPreferences((prev) =>
      prev.map((p) => (p.notificationType === notificationType ? { ...p, [field]: value } : p)),
    )
    try {
      await updateNotificationPreferences([{ notificationType, [field]: value }])
    } catch {
      setPreferences((prev) =>
        prev.map((p) =>
          p.notificationType === notificationType ? { ...p, [field]: !value } : p,
        ),
      )
      setStatus({ type: 'error', message: 'Failed to save notification setting.' })
    }
  }

  return (
    <section id="notification-settings" className="settings-card">
      <h1>Notification Settings</h1>

      {loading && <p className="settings-status">Loading...</p>}
      {loadError && <p className="settings-status settings-status-error">{loadError}</p>}

      {preferences && (
        <div className="notification-settings-list">
          {preferences.map(({ notificationType, description, enabled, emailEnabled, enabledLocked }) => (
            <div className="notification-settings-row" key={notificationType}>
              <span className="notification-settings-label">
                <span className="notification-settings-name">{notificationType}</span>
                {description && (
                  <span className="notification-settings-description">{description}</span>
                )}
              </span>
              <div className="notification-settings-switches">
                <label
                  className="notification-settings-switch-group"
                  title={enabledLocked ? 'This notification type cannot be disabled in-app.' : undefined}
                >
                  <span className="notification-settings-switch-label">In-app</span>
                  <span className="notification-settings-switch">
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={enabledLocked}
                      onChange={(event) =>
                        handleToggle(notificationType, 'enabled', event.target.checked)
                      }
                    />
                    <span className="notification-settings-switch-track" />
                  </span>
                </label>
                <label className="notification-settings-switch-group">
                  <span className="notification-settings-switch-label">Email</span>
                  <span className="notification-settings-switch">
                    <input
                      type="checkbox"
                      checked={emailEnabled}
                      onChange={(event) =>
                        handleToggle(notificationType, 'emailEnabled', event.target.checked)
                      }
                    />
                    <span className="notification-settings-switch-track" />
                  </span>
                </label>
              </div>
            </div>
          ))}
        </div>
      )}

      {status && (
        <p
          className={
            status.type === 'error' ? 'settings-status settings-status-error' : 'settings-status'
          }
        >
          {status.message}
        </p>
      )}
    </section>
  )
}

export default NotificationSettings
