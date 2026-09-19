import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import './RevealableSecret.css'

/**
 * Hides something sensitive behind an eye toggle, starting concealed.
 *
 * Built for CAST join codes and their QR codes, which sit in view the whole time
 * a session runs - including on a screen share or a stream, where anyone
 * watching could otherwise read the code and walk in.
 *
 * @param {object} props
 * @param {import('react').ReactNode} props.children The secret itself, rendered only once revealed.
 * @param {string} props.label What is being revealed, for the toggle's accessible name (e.g. "join code").
 * @param {import('react').ReactNode} [props.masked] What to show while concealed; defaults to a run of dots.
 * @param {string} [props.className] Extra class on the wrapper.
 * @param {string} [props.as] Wrapper element, defaulting to a span so this is safe inside a paragraph.
 */
function RevealableSecret({ children, label, masked, className = '', as: Wrapper = 'span' }) {
  const [revealed, setRevealed] = useState(false)
  const action = revealed ? `Hide ${label}` : `Show ${label}`

  return (
    <Wrapper className={`revealable-secret ${className}`.trim()}>
      {revealed ? children : (
        <span className="revealable-secret-mask" aria-hidden="true">
          {masked ?? '••••••'}
        </span>
      )}
      <button
        type="button"
        className="revealable-secret-toggle"
        onClick={() => setRevealed((prev) => !prev)}
        aria-pressed={revealed}
        aria-label={action}
        title={action}
      >
        {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </Wrapper>
  )
}

export default RevealableSecret
