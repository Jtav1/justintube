import { createElement } from 'react'
import { Link } from 'react-router-dom'

/**
 * Punctuation commonly typed immediately before/after a URL in prose (e.g.
 * "(/video?v=abc)" or "check /video?v=abc.") that isn't meant to be part of
 * the link itself. Stripped off before matching, then re-emitted as plain
 * text around the link.
 * @type {RegExp}
 */
const LEADING_PUNCTUATION_REGEX = /^[(["']+/
const TRAILING_PUNCTUATION_REGEX = /[)\]"'.,!?;:]+$/

/**
 * Matches a punctuation-stripped token that looks like it might be a link:
 * either an absolute http(s) URL, or a root-relative path starting with a
 * single `/` (never `//`, which is a protocol-relative URL that can point at
 * an arbitrary host).
 * @type {RegExp}
 */
const CANDIDATE_LINK_REGEX = /^(?:https?:\/\/\S+|\/(?!\/)\S+)$/

/**
 * Resolves a candidate token against the site's own origin and confirms the
 * result still resolves to that same origin. Using `URL` for this (rather
 * than string-prefix checks) is what makes the check safe: it normalizes
 * scheme-relative ("//evil.com/x") and backslash ("/\evil.com") tricks the
 * same way a browser would before `origin` is read off the result, so both
 * end up resolving to a different origin and get rejected.
 * @param {string} token Punctuation-stripped candidate link text.
 * @returns {URL|null} The resolved same-origin URL, or null when the token
 *   isn't a valid URL, or resolves off-site.
 */
function resolveSameOriginUrl(token) {
  try {
    const resolved = new URL(token, window.location.origin)
    return resolved.origin === window.location.origin ? resolved : null
  } catch {
    return null
  }
}

/**
 * Splits comment text into an array of plain strings and `<Link>` elements,
 * turning any whitespace-delimited token that resolves to a page on this
 * same server (an absolute URL sharing this origin, or a root-relative path)
 * into a clickable in-app link. A link to any other origin is left exactly
 * as typed, as plain text - this never renders an `<a href>`/navigable link
 * to an arbitrary external URL. Always returns React children (strings or
 * elements), never raw HTML, so it can't reintroduce XSS.
 * @param {string} text Raw comment body.
 * @returns {Array<string|import('react').ReactNode>} Children for a JSX container.
 */
export function linkifyCommentText(text) {
  if (!text) {
    return [text]
  }

  // Split on whitespace, keeping the whitespace itself as separate tokens so
  // the output round-trips exactly (comment text renders inside a
  // `white-space: pre-wrap` element).
  const tokens = text.split(/(\s+)/)
  const nodes = []

  tokens.forEach((token, index) => {
    if (!token || /^\s+$/.test(token)) {
      nodes.push(token)
      return
    }

    const leadingMatch = token.match(LEADING_PUNCTUATION_REGEX)
    const leading = leadingMatch ? leadingMatch[0] : ''
    const afterLeading = leading ? token.slice(leading.length) : token

    const trailingMatch = afterLeading.match(TRAILING_PUNCTUATION_REGEX)
    const trailing = trailingMatch ? trailingMatch[0] : ''
    const core = trailing ? afterLeading.slice(0, -trailing.length) : afterLeading

    if (!core || !CANDIDATE_LINK_REGEX.test(core)) {
      nodes.push(token)
      return
    }

    const resolved = resolveSameOriginUrl(core)
    if (!resolved) {
      nodes.push(token)
      return
    }

    if (leading) {
      nodes.push(leading)
    }
    const to = `${resolved.pathname}${resolved.search}${resolved.hash}`
    nodes.push(createElement(Link, { key: index, to, className: 'video-comments-item-link' }, core))
    if (trailing) {
      nodes.push(trailing)
    }
  })

  return nodes
}
