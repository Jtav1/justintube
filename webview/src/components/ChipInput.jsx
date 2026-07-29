import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import './ChipInput.css'

/**
 * Generic removable-chip list with a text input.
 *
 * Freeform mode (pass `onAddFreeform`, used for tags): typing a comma or
 * pressing Enter converts the current input text into one or more chips.
 *
 * Suggestion mode (pass `suggestions` + `onSelectSuggestion`, used for the
 * private-video recipient picker): matches are rendered in a dropdown below
 * the input and clicking one adds it as a chip.
 */
function ChipInput({
  chips,
  onRemove,
  inputValue,
  onInputChange,
  placeholder,
  onAddFreeform,
  suggestions,
  onSelectSuggestion,
  suggestionsLoading,
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const wrapRef = useRef(null)

  const hasSuggestionMode = Boolean(suggestions)

  useEffect(() => {
    if (!hasSuggestionMode) {
      return undefined
    }

    function handleClickOutside(event) {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) {
        setDropdownOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [hasSuggestionMode])

  function handleKeyDown(event) {
    if (!onAddFreeform) {
      return
    }
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      onAddFreeform(inputValue)
    } else if (event.key === 'Backspace' && !inputValue && chips.length > 0) {
      onRemove(chips[chips.length - 1].key)
    }
  }

  function handleInputChange(event) {
    onInputChange(event.target.value)
    if (hasSuggestionMode) {
      setDropdownOpen(true)
    }
  }

  const showDropdown =
    hasSuggestionMode && dropdownOpen && (suggestionsLoading || suggestions.length > 0)

  return (
    <div className="chip-input" ref={wrapRef}>
      <div className="chip-input-field">
        {chips.map((chip) => (
          <span key={chip.key} className="chip-input-chip">
            {chip.label}
            <button
              type="button"
              className="chip-input-remove"
              onClick={() => onRemove(chip.key)}
              aria-label={`Remove ${chip.label}`}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          type="text"
          className="chip-input-text"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => hasSuggestionMode && setDropdownOpen(true)}
          placeholder={chips.length === 0 ? placeholder : ''}
        />
      </div>
      {showDropdown && (
        <div className="chip-input-dropdown" role="listbox">
          {suggestionsLoading ? (
            <div className="chip-input-dropdown-status">Searching...</div>
          ) : (
            suggestions.map((suggestion) => (
              <button
                type="button"
                key={suggestion.key}
                className="chip-input-suggestion"
                onClick={() => {
                  onSelectSuggestion(suggestion.key)
                  setDropdownOpen(false)
                }}
              >
                {suggestion.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export default ChipInput
