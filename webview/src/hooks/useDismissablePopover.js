import { useEffect } from 'react'

/**
 * Shared behavior for popovers/dropdowns/menus: closes on Escape (returning
 * focus to the trigger element, required for keyboard users to operate and
 * recover from these WAI-ARIA menu/dialog patterns) and, when `dismissRefs`
 * is given, closes on any click outside all of the listed elements - pass
 * every DOM subtree the popover's own content lives in, including portaled
 * dropdowns that render outside the trigger's own subtree.
 *
 * @param {boolean} open Whether the popover is currently open.
 * @param {() => void} onClose Closes the popover.
 * @param {{ current: HTMLElement|null }} triggerRef Ref to the element that opens/toggles the popover; receives focus back on Escape-close.
 * @param {{ dismissRefs?: Array<{ current: HTMLElement|null }> }} [options] `dismissRefs`: elements a click inside any of which should NOT close the popover. Omit to skip outside-click handling.
 */
export function useDismissablePopover(open, onClose, triggerRef, { dismissRefs } = {}) {
  useEffect(() => {
    if (!open) {
      return undefined
    }

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        triggerRef?.current?.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose, triggerRef])

  useEffect(() => {
    if (!open || !dismissRefs) {
      return undefined
    }

    function handleClickOutside(event) {
      const clickedInside = dismissRefs.some((ref) => ref?.current?.contains(event.target))
      if (!clickedInside) {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dismissRefs is a fresh array literal per call; spread its contents instead.
  }, [open, onClose, ...dismissRefs ?? []])
}
