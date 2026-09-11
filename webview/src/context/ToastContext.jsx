import { useCallback, useRef, useState } from 'react'
import { ToastContext } from './toast-context.js'
import ToastContainer from '../components/ToastContainer.jsx'

const MAX_TOASTS = 5
const EXIT_DURATION = 200
const DEFAULT_DURATIONS = { success: 4000, info: 4000, error: 7000 }

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const nextId = useRef(0)

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.map((toast) => (toast.id === id ? { ...toast, closing: true } : toast)))
    setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id))
    }, EXIT_DURATION)
  }, [])

  const showToast = useCallback((type, message, options = {}) => {
    const id = nextId.current++
    const duration = options.duration ?? DEFAULT_DURATIONS[type] ?? DEFAULT_DURATIONS.info
    setToasts((prev) => {
      const next = [...prev, { id, type, message, duration, closing: false }]
      return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next
    })
    return id
  }, [])

  const success = useCallback((message, options) => showToast('success', message, options), [showToast])
  const error = useCallback((message, options) => showToast('error', message, options), [showToast])
  const info = useCallback((message, options) => showToast('info', message, options), [showToast])

  return (
    <ToastContext.Provider value={{ showToast, success, error, info, dismiss }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}
