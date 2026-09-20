import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SmilePlus } from 'lucide-react'
import { listReactionEmoji } from '../api/watch-party.js'
import { useWatchParty } from '../context/useWatchParty.js'
import { useDismissablePopover } from '../hooks/useDismissablePopover.js'
import './WatchPartyReactionBar.css'

// Loaded only when the picker is first opened: the emoji dataset is large and
// most sessions never open it, so it has no business in the main chunk.
const EmojiPicker = lazy(() => import('emoji-picker-react'))

const PICKER_WIDTH = 340
const PICKER_MAX_HEIGHT = 420
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
 * Positions the picker panel: left-aligned to the trigger, then clamped into
 * the viewport - the same anchor-and-clamp shape as NotificationBell's
 * computeDropdownPosition. It used to pin `left` to the viewport's right edge
 * and never read the rect's horizontal position at all, which on a wide screen
 * parked the panel over the session sidebar roughly a thousand pixels away from
 * the button that opened it.
 *
 * Vertically it still prefers to open *above* the bar, which is what keeps it
 * off the video: the reaction bar sits below the player, so opening upward
 * covers the player's bottom edge at worst, and only falls downward when the
 * viewport is too short. Height shrinks to whatever the viewport actually has.
 *
 * @param {DOMRect} rect The trigger button's bounding rect.
 * @returns {{top: number, left: number, width: number, height: number}} Fixed-position style values.
 */
function computePickerPosition(rect) {
  const width = Math.min(PICKER_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2)
  const height = Math.min(PICKER_MAX_HEIGHT, window.innerHeight - VIEWPORT_MARGIN * 2)
  const fitsAbove = rect.top >= height + VIEWPORT_MARGIN
  const top = fitsAbove
    ? rect.top - height - 6
    : Math.min(rect.bottom + 6, window.innerHeight - height - VIEWPORT_MARGIN)
  const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN
  return {
    top: Math.max(VIEWPORT_MARGIN, top),
    left: Math.max(VIEWPORT_MARGIN, Math.min(rect.left, maxLeft)),
    width,
    height,
  }
}

/**
 * The Watch Party's reaction bar: the instance's most-used emoji (ranked
 * server-side, so everyone sees the same row) plus a picker for anything else.
 * Reactions themselves are fire-and-forget over the socket; the floating
 * animation is WatchPartyReactions' job.
 */
function WatchPartyReactionBar() {
  const { sendReaction } = useWatchParty()
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

  // Reposition on resize *and* scroll: the panel is position:fixed, so a scroll
  // leaves it stranded away from the trigger it's anchored to.
  useEffect(() => {
    if (!pickerOpen) {
      return undefined
    }
    function reposition() {
      if (toggleRef.current) {
        setPickerPosition(computePickerPosition(toggleRef.current.getBoundingClientRect()))
      }
    }
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
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
    // Closed on the next frame, not synchronously: emoji-picker-react handles
    // the pick from its own passive native listener, so tearing the panel out
    // from under the pointer mid-gesture lets the rest of the click land on
    // whatever is beneath - and on Windows a click on the video surface is a
    // native play/pause toggle, which then pauses the session for everyone.
    requestAnimationFrame(() => setPickerOpen(false))
    if (!emoji.includes(picked)) {
      setRefreshKey((key) => key + 1)
    }
  }

  return (
    <div className="watch-party-reaction-bar">
      {emoji.map((value) => (
        <button
          key={value}
          type="button"
          className="watch-party-reaction-bar-btn"
          onClick={() => sendReaction(value)}
          aria-label={`React with ${value}`}
        >
          {value}
        </button>
      ))}
      <button
        type="button"
        className="watch-party-reaction-bar-btn watch-party-reaction-bar-more"
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
        <>
          {/* Swallows every pointer event outside the panel while it's open.
              Load-bearing, not decoration: without it a click that misses (or
              slips out of) the panel reaches the video underneath, and the
              browser's native click-to-pause then pauses the whole session.
              It doubles as the click-outside-to-close handler. */}
          <div
            className="watch-party-reaction-picker-backdrop"
            onMouseDown={() => setPickerOpen(false)}
          />
          <div
            className="watch-party-reaction-picker"
            ref={panelRef}
            style={{
              position: 'fixed',
              top: pickerPosition.top,
              left: pickerPosition.left,
              width: pickerPosition.width,
            }}
          >
            <Suspense fallback={<p className="watch-party-reaction-picker-loading">Loading emoji…</p>}>
              {/* native: renders with the system emoji font instead of fetching
                  images from a CDN, which a self-hosted instance shouldn't depend
                  on (and which would break offline). */}
              <EmojiPicker
                onEmojiClick={handlePick}
                emojiStyle="native"
                lazyLoadEmojis
                autoFocusSearch={false}
                width="100%"
                height={pickerPosition.height}
                previewConfig={{ showPreview: false }}
              />
            </Suspense>
          </div>
        </>,
        document.body,
      )}
    </div>
  )
}

export default WatchPartyReactionBar
