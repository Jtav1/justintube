import './ProgressBar.css'

/**
 * A labeled progress bar: a determinate fill (0-100) when `indeterminate` is
 * false, or a CSS-animated sweep when it's true (used when no real
 * percentage is available, e.g. the URL-import download phase).
 * @param {{ value?: number, indeterminate?: boolean, label: string }} props
 */
function ProgressBar({ value = 0, indeterminate = false, label }) {
  const clamped = Math.max(0, Math.min(100, value))
  return (
    <div className="progress-bar-wrap">
      <p className="progress-bar-label">{label}</p>
      <div
        className={`progress-bar-track${indeterminate ? ' progress-bar-indeterminate' : ''}`}
        role="progressbar"
        aria-label={label}
        aria-valuenow={indeterminate ? undefined : Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="progress-bar-fill"
          style={indeterminate ? undefined : { width: `${clamped}%` }}
        />
      </div>
    </div>
  )
}

export default ProgressBar
