import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SmilePlus } from 'lucide-react'
import { listReactionEmoji } from '../api/cast.js'
import { useCast } from '../context/useCast.js'
import { useDismissablePopover } from '../hooks/useDismissablePopover.js'
import './CastReactionBar.css'

// Loaded only when the picker is first opened: the emoji dataset is large and
// most sessions never open it, so it has no business in the main chunk.
const EmojiPicker = lazy(() => import('emoji-picker-react'))

const PICKER_WIDTH = 340
const PICKER_HEIGHT = 420
const VIEWPORT_MARGIN = 12

/**
 * Shown until the ranked list loads, and if the request fails - the bar should
 * never render empty. Mirrors DEFAULT_REACTION_EMOJI in
 * webapi/lib/cast/emoji-usage.js, which seeds the same six.
 *
 * @type {string[]}
 */
const FALLBACK_EMOJI = ['👍', '😂', '😮', '❤️', '🎉', '👎']

/**
 * Positions the picker panel above the trigger where there's room, flipping
 * below when there isn't, and clamped to the viewport. Same rect-based
 * approach as StartCastPopover.
 *
 * @param {DOMRect} rect The trigger button's bounding rect.
 * @returns {{top: number, left: number, width: number}} Fixed-position style values.
 */
function computePickerPosition(rect) {
  const width = Math.min(PICKER_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2)
  const fitsAbove = rect.top >= PICKER_HEIGHT + VIEWPORT_MARGIN
  const top = fitsAbove
    ? rect.top - PICKER_HEIGHT - 6
    : Math.min(rect.bottom + 6, window.innerHeight - PICKER_HEIGHT - VIEWPORT_MARGIN)
  const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN
  return {
    top: Math.max(VIEWPORT_MARGIN, top),
    left: Math.max(VIEWPORT_MARGIN, Math.min(rect.left, maxLeft)),
    width,
  }
}

/**
 * The CAST session's reaction bar: the instance's most-used emoji (ranked
 * server-side, so everyone sees the same row) plus a picker for anything else.
 * Reactions themselves are fire-and-forget over the socket; the floating
 * animation is CastReactions' job.
 */
function CastReactionBar() {
  const { sendReaction } = useCast()
  const [emoji, setEmoji] = useState(FALLBACK_EMOJI)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerPosition, setPickerPosition] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const toggleRef = useRef(null)
  const panelRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    async function loadEmoji() {
      try {
        const data = await listReactionEmoji(FALLBACK_EMOJI.length)
        if (!cancelled && data.items?.length) {
          setEmoji(data.items)
        }
      } catch {
        // Keep the fallback row - a failed ranking request shouldn't cost the
        // user their ability to react.
      }
    }
    loadEmoji()
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  useEffect(() => {
    if (!pickerOpen) {
      return undefined
    }
    function handleClickOutside(event) {
      const clickedTrigger = toggleRef.current?.contains(event.target)
      const clickedPanel = panelRef.current?.contains(event.target)
      if (!clickedTrigger && !clickedPanel) {
        setPickerOpen(false)
      }
    }
    function handleResize() {
      if (toggleRef.current) {
        setPickerPosition(computePickerPosition(toggleRef.current.getBoundingClientRect()))
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    window.addEventListener('resize', handleResize)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      window.removeEventListener('resize', handleResize)
    }
  }, [pickerOpen])

  useDismissablePopover(pickerOpen, () => setPickerOpen(false), toggleRef)

  function handleTogglePicker() {
    if (pickerOpen) {
      setPickerOpen(false)
      return
    }
    if (toggleRef.current) {
      setPickerPosition(computePickerPosition(toggleRef.current.getBoundingClientRect()))
    }
    setPickerOpen(true)
  }

  /**
   * Sends the picked emoji and closes. Only refetches the ranked row when the
   * pick isn't already in it - re-ranking on every tap of an existing emoji
   * would be a request per reaction for no visible change.
   *
   * @param {{emoji: string}} selection emoji-picker-react's selection payload.
   * @returns {void}
   */
  function handlePick(selection) {
    const picked = selection?.emoji
    if (!picked) {
      return
    }
    sendReaction(picked)
    setPickerOpen(false)
    if (!emoji.includes(picked)) {
      setRefreshKey((key) => key + 1)
    }
  }

  return (
    <div className="cast-reaction-bar">
      {emoji.map((value) => (
        <button
          key={value}
          type="button"
          className="cast-reaction-bar-btn"
          onClick={() => sendReaction(value)}
          aria-label={`React with ${value}`}
        >
          {value}
        </button>
      ))}
      <button
        type="button"
        className="cast-reaction-bar-btn cast-reaction-bar-more"
        onClick={handleTogglePicker}
        aria-label="React with any emoji"
        title="React with any emoji"
        aria-haspopup="dialog"
        aria-expanded={pickerOpen}
        ref={toggleRef}
      >
        <SmilePlus size={18} />
      </button>
      {pickerOpen && pickerPosition && createPortal(
        <div
          className="cast-reaction-picker"
          ref={panelRef}
          style={{
            position: 'fixed',
            top: pickerPosition.top,
            left: pickerPosition.left,
            width: pickerPosition.width,
          }}
        >
          <Suspense fallback={<p className="cast-reaction-picker-loading">Loading emoji…</p>}>
            {/* native: renders with the system emoji font instead of fetching
                images from a CDN, which a self-hosted instance shouldn't depend
                on (and which would break offline). */}
            <EmojiPicker
              onEmojiClick={handlePick}
              emojiStyle="native"
              lazyLoadEmojis
              width="100%"
              height={PICKER_HEIGHT}
              previewConfig={{ showPreview: false }}
            />
          </Suspense>
        </div>,
        document.body,
      )}
    </div>
  )
}

export default CastReactionBar
