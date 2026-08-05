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
 *
 * Pass `renderChipExtra(chip)` to render extra content per chip between its
 * label and remove button (used for the recipient picker's view/edit
 * permission select).
 */
let idCounter = 0

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
  inputMaxLength,
  renderChipExtra,
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [instanceId] = useState(() => `chip-input-${++idCounter}`)
  const wrapRef = useRef(null)

  const hasSuggestionMode = Boolean(suggestions)

  useEffect(() => {
    if (!hasSuggestionMode) {
      return undefined
    }

    function handleClickOutside(event) {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) {
        setDropdownOpen(false)
        setActiveIndex(-1)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [hasSuggestionMode])

  function handleKeyDown(event) {
    if (hasSuggestionMode) {
      if (!dropdownOpen || suggestions.length === 0) {
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex((prev) => (prev + 1) % suggestions.length)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1))
      } else if (event.key === 'Enter' && activeIndex >= 0) {
        event.preventDefault()
        onSelectSuggestion(suggestions[activeIndex].key)
        setDropdownOpen(false)
        setActiveIndex(-1)
      } else if (event.key === 'Escape') {
        setDropdownOpen(false)
        setActiveIndex(-1)
      }
      return
    }
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
      setActiveIndex(-1)
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
            {renderChipExtra?.(chip)}
            <button
              type="button"
              className="chip-input-remove"
              onClick={() => onRemove(chip.key)}
              aria-label={`Remove ${chip.label}`}
              title={`Remove ${chip.label}`}
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
          maxLength={inputMaxLength}
          {...(hasSuggestionMode && {
            role: 'combobox',
            'aria-expanded': showDropdown,
            'aria-autocomplete': 'list',
            'aria-controls': `${instanceId}-listbox`,
            'aria-activedescendant':
              showDropdown && activeIndex >= 0 ? `${instanceId}-option-${activeIndex}` : undefined,
          })}
        />
      </div>
      {showDropdown && (
        <div className="chip-input-dropdown" role="listbox" id={`${instanceId}-listbox`}>
          {suggestionsLoading ? (
            <div className="chip-input-dropdown-status">Searching...</div>
          ) : (
            suggestions.map((suggestion, index) => (
              <button
                type="button"
                key={suggestion.key}
                id={`${instanceId}-option-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                className={`chip-input-suggestion${index === activeIndex ? ' chip-input-suggestion-active' : ''}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => {
                  onSelectSuggestion(suggestion.key)
                  setDropdownOpen(false)
                  setActiveIndex(-1)
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
