import { useEffect } from 'react'

/**
 * Shared behavior for popovers/dropdowns/menus: closes on outside-click
 * (existing behavior, kept per-caller) plus closes on Escape and returns
 * focus to the trigger element that opened it, both required for keyboard
 * users to operate and recover from these WAI-ARIA menu/dialog patterns.
 *
 * @param {boolean} open Whether the popover is currently open.
 * @param {() => void} onClose Closes the popover.
 * @param {{ current: HTMLElement|null }} triggerRef Ref to the element that opens/toggles the popover; receives focus back on Escape-close.
 */
export function useDismissablePopover(open, onClose, triggerRef) {
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
}
