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
 * Two variants: `"swap"` (default) replaces the content with a short inline
 * mask, for text that must not reflow when revealed. `"blur"` keeps the
 * content in place and blurs it, for a block like a QR code.
 *
 * @param {object} props
 * @param {import('react').ReactNode} props.children The secret to conceal.
 * @param {string} props.label Noun phrase for the toggle's label, e.g. "join code".
 * @param {import('react').ReactNode} [props.masked] What to show in place of the secret; `variant="swap"` only.
 * @param {string} [props.className] Extra class on the wrapper.
 * @param {string} [props.as] Wrapper element type; defaults to a span.
 * @param {"swap"|"blur"} [props.variant] How to conceal - see above.
 * @returns {import('react').ReactElement} The concealed secret and its toggle.
 */
function RevealableSecret({
  children,
  label,
  masked,
  className = '',
  as: Wrapper = 'span',
  variant = 'swap',
}) {
  const [revealed, setRevealed] = useState(false)
  const action = revealed ? `Hide ${label}` : `Show ${label}`
  const blur = variant === 'blur'

  let body
  if (blur) {
    // Rendered either way to keep the block's size identical revealed or not.
    body = revealed ? children : (
      <span className="revealable-secret-blurred" aria-hidden="true">
        {children}
      </span>
    )
  } else if (revealed) {
    body = children
  } else {
    body = (
      <span className="revealable-secret-mask" aria-hidden="true">
        {masked ?? '••••••'}
      </span>
    )
  }

  const wrapperClass = [
    'revealable-secret',
    blur ? 'revealable-secret-overlay' : '',
    blur ? (revealed ? 'revealable-secret-overlay-shown' : 'revealable-secret-overlay-hidden') : '',
    className,
  ].filter(Boolean).join(' ')

  return (
    <Wrapper className={wrapperClass}>
      {body}
      <button
        type="button"
        className="revealable-secret-toggle"
        onClick={() => setRevealed((prev) => !prev)}
        aria-pressed={revealed}
        aria-label={action}
        title={action}
      >
        {revealed ? <EyeOff size={blur ? 20 : 14} /> : <Eye size={blur ? 20 : 14} />}
      </button>
    </Wrapper>
  )
}

export default RevealableSecret
