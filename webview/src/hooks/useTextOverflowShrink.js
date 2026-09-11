import { useEffect, useState } from 'react'

let sharedCanvas = null

function getMeasureContext() {
  sharedCanvas ??= document.createElement('canvas')
  return sharedCanvas.getContext('2d')
}

/**
 * Tracks whether `text`, rendered at `fontSize`/`fontWeight`, is wider than
 * the element `ref` currently points to - re-measured whenever the element
 * resizes. Used to shrink a title's font size only when it would otherwise
 * overflow/wrap. `fontSize`/`fontWeight` must match the CSS actually applied
 * to the element (measurement uses the element's computed font-family only).
 *
 * @param {{ current: HTMLElement|null }} ref Ref to the text element to measure.
 * @param {string} text The text content being measured.
 * @param {{ fontSize: number, fontWeight: number }} options Must match the element's CSS font-size/font-weight.
 * @returns {boolean} True once the natural text width exceeds the element's current width.
 */
export function useTextOverflowShrink(ref, text, { fontSize, fontWeight }) {
  const [shrunk, setShrunk] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) {
      return undefined
    }

    function measure() {
      const ctx = getMeasureContext()
      const fontFamily = getComputedStyle(el).fontFamily
      ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`
      const naturalWidth = ctx.measureText(text ?? '').width
      setShrunk(naturalWidth > el.clientWidth)
    }

    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, text, fontSize, fontWeight])

  return shrunk
}
