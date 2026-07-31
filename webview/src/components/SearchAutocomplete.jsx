import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { suggestSearch } from '../api/search.js'
import './SearchAutocomplete.css'

const SUGGESTION_LIMIT = 15
const DEBOUNCE_MS = 200

function SearchAutocomplete({ value, onChange }) {
  const navigate = useNavigate()
  const [suggestions, setSuggestions] = useState([])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const wrapperRef = useRef(null)
  const debounceRef = useRef(null)

  const trimmedValue = value.trim()
  // Adjusted during render (not an effect) so clearing the input closes the
  // dropdown immediately: https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [clearedFor, setClearedFor] = useState(null)
  if (!trimmedValue && clearedFor !== value) {
    setClearedFor(value)
    setSuggestions([])
    setOpen(false)
    setActiveIndex(-1)
  }

  useEffect(() => {
    const trimmed = value.trim()
    if (!trimmed) {
      return undefined
    }

    let cancelled = false
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await suggestSearch(trimmed, { limit: SUGGESTION_LIMIT })
        if (!cancelled) {
          setSuggestions(data.items)
          setOpen(true)
          setActiveIndex(-1)
        }
      } catch {
        if (!cancelled) {
          setSuggestions([])
        }
      }
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(debounceRef.current)
    }
  }, [value])

  useEffect(() => {
    if (!open) {
      return undefined
    }

    function handleClickOutside(event) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  function goToSuggestion(suggestion) {
    setOpen(false)
    navigate(`/video?v=${suggestion.videoId}`)
  }

  function handleKeyDown(event) {
    if (!open || suggestions.length === 0) {
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((prev) => (prev + 1) % suggestions.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1))
    } else if (event.key === 'Enter') {
      if (activeIndex >= 0 && activeIndex < suggestions.length) {
        event.preventDefault()
        goToSuggestion(suggestions[activeIndex])
      } else {
        setOpen(false)
      }
    } else if (event.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="search-autocomplete" ref={wrapperRef}>
      <input
        type="text"
        className="topbar-search-input"
        placeholder="Search"
        aria-label="Search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        onKeyDown={handleKeyDown}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {open && suggestions.length > 0 && (
        <ul className="search-autocomplete-dropdown" role="listbox">
          {suggestions.map((suggestion, index) => (
            <li key={suggestion.id} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={`search-autocomplete-item${index === activeIndex ? ' search-autocomplete-item-active' : ''}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => goToSuggestion(suggestion)}
              >
                <span className="search-autocomplete-item-title">{suggestion.title}</span>
                {suggestion.uploader && (
                  <span className="search-autocomplete-item-meta">
                    {suggestion.uploader.displayName || suggestion.uploader.username}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default SearchAutocomplete
