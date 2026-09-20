import { useEffect } from 'react'
import { X } from 'lucide-react'
import './Modal.css'

/**
 * Generic centered modal dialog: dimmed overlay, titled panel, close button.
 * Closes on overlay click or Escape. Renders nothing when `open` is false.
 * @param {{ open: boolean, title: string, onClose: () => void, children: import('react').ReactNode }} props
 */
function Modal({ open, title, onClose, children }) {
  useEffect(() => {
    if (!open) {
      return undefined
    }
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) {
    return null
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title">{title}</h2>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

export default Modal
