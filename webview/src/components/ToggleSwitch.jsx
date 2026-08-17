import './ToggleSwitch.css'

/**
 * A labeled iOS-style toggle switch backed by a native checkbox for
 * accessibility (keyboard focus, screen readers, form semantics).
 * @param {{ checked: boolean, onChange: (checked: boolean) => void, label?: string, id?: string, disabled?: boolean }} props
 */
function ToggleSwitch({ checked, onChange, label, id, disabled = false }) {
  return (
    <label className="toggle-switch-group" htmlFor={id}>
      {label && <span className="toggle-switch-label">{label}</span>}
      <span className="toggle-switch">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="toggle-switch-track" />
      </span>
    </label>
  )
}

export default ToggleSwitch
