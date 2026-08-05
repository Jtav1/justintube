import { useCallback, useEffect, useRef } from 'react'
import { CheckCircle2, Info, AlertCircle, X } from 'lucide-react'
import './ToastContainer.css'

const ICONS = { success: CheckCircle2, error: AlertCircle, info: Info }
const ROLES = { success: 'status', info: 'status', error: 'alert' }

/**
 * A single toast, owning its own auto-dismiss timer so hover/focus can pause
 * it without affecting sibling toasts.
 * @param {{toast: object, onDismiss: (id: number) => void}} props
 */
function ToastItem({ toast, onDismiss }) {
  const timerRef = useRef(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const startTimer = useCallback(() => {
    clearTimer()
    timerRef.current = setTimeout(() => onDismiss(toast.id), toast.duration)
  }, [clearTimer, onDismiss, toast.id, toast.duration])

  useEffect(() => {
    startTimer()
    return clearTimer
  }, [startTimer, clearTimer])

  const Icon = ICONS[toast.type] || Info

  return (
    <div
      className={`toast toast-${toast.type}${toast.closing ? ' toast-closing' : ''}`}
      role={ROLES[toast.type] || 'status'}
      aria-atomic="true"
      onMouseEnter={clearTimer}
      onMouseLeave={startTimer}
      onFocus={clearTimer}
      onBlur={startTimer}
    >
      <Icon size={20} className="toast-icon" aria-hidden="true" />
      <p className="toast-message">{toast.message}</p>
      <button
        type="button"
        className="toast-close"
        aria-label="Dismiss notification"
        title="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
      >
        <X size={16} />
      </button>
    </div>
  )
}

/**
 * Renders the app-wide toast stack, fixed to the bottom-right corner.
 * @param {{toasts: object[], onDismiss: (id: number) => void}} props
 */
function ToastContainer({ toasts, onDismiss }) {
  if (toasts.length === 0) {
    return null
  }

  return (
    <div className="toast-container">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

export default ToastContainer
