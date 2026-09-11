/**
 * Minimal email format check: local part, "@", domain with at least one dot.
 * Not RFC 5322-complete — just enough to reject obviously malformed input
 * before it's stored and later used as a send-to address.
 *
 * @type {RegExp}
 */
const EMAIL_FORMAT_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Checks whether a string is a plausibly formatted email address.
 *
 * @param {string} email Candidate email address (already trimmed).
 * @returns {boolean} True when the string matches a basic email shape.
 */
export function isValidEmailFormat(email) {
  return EMAIL_FORMAT_PATTERN.test(email);
}
