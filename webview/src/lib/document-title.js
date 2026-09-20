export const SITE_NAME = 'Justintube'

/**
 * Builds a document title, suffixed with the site name. A blank or missing
 * title gives the site name alone rather than a dangling separator.
 *
 * @param {string|null|undefined} title The page-specific part of the title.
 * @returns {string} The full document title.
 */
export function formatDocumentTitle(title) {
  const trimmed = typeof title === 'string' ? title.trim() : ''
  return trimmed ? `${trimmed} - ${SITE_NAME}` : SITE_NAME
}
