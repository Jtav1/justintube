/**
 * Formats a duration in seconds as "m:ss" or "h:mm:ss".
 * @param {number|null|undefined} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) {
    return ''
  }

  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

/**
 * Compacts a view count, e.g. 1234 -> "1.2K views".
 * @param {number|null|undefined} count
 * @returns {string}
 */
export function formatViewCount(count) {
  const n = Number(count) || 0
  let compact = String(n)
  if (n >= 1_000_000) {
    compact = `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  } else if (n >= 1_000) {
    compact = `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  }
  return `${compact} view${n === 1 ? '' : 's'}`
}

const RELATIVE_UNITS = [
  { unit: 'year', seconds: 31536000 },
  { unit: 'month', seconds: 2592000 },
  { unit: 'week', seconds: 604800 },
  { unit: 'day', seconds: 86400 },
  { unit: 'hour', seconds: 3600 },
  { unit: 'minute', seconds: 60 },
]

/**
 * Formats a date as a relative time, e.g. "3 days ago".
 * @param {string|Date} date
 * @returns {string}
 */
export function formatRelativeDate(date) {
  const then = new Date(date).getTime()
  if (Number.isNaN(then)) {
    return ''
  }

  const diffSeconds = Math.floor((Date.now() - then) / 1000)
  if (diffSeconds < 60) {
    return 'just now'
  }

  for (const { unit, seconds } of RELATIVE_UNITS) {
    const value = Math.floor(diffSeconds / seconds)
    if (value >= 1) {
      return `${value} ${unit}${value === 1 ? '' : 's'} ago`
    }
  }
  return 'just now'
}
