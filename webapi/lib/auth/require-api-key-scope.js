/**
 * Canonical API key scope names, matching the seeded API_KEY_SCOPES rows
 * (see DEFAULT_API_KEY_SCOPES in lib/seed.js). "full_access" is a superset of
 * the other three, not something combined with them for a narrower grant.
 *
 * @type {string[]}
 */
export const API_KEY_SCOPE_NAMES = [
  "view_only",
  "content_edit",
  "profile_edit",
  "full_access",
];

/**
 * Checks whether a set of granted API-key scope names satisfies a required
 * scope tier. `full_access` always satisfies every tier. Any granted scope
 * satisfies `view_only`, since editing a resource implies being able to view
 * it. Otherwise the granted scopes must contain the required tier exactly.
 *
 * @param {string[]|null|undefined} grantedScopes Scope names granted to the API key.
 * @param {string} requiredScope Scope tier the route requires.
 * @returns {boolean} True when the granted scopes satisfy the requirement.
 */
export function scopeSatisfies(grantedScopes, requiredScope) {
  const granted = new Set(grantedScopes || []);
  if (granted.has("full_access")) {
    return true;
  }
  if (requiredScope === "view_only") {
    return granted.size > 0;
  }
  return granted.has(requiredScope);
}

/**
 * Express middleware factory that restricts a route to API keys carrying a
 * sufficient scope. Must run after `requireAuth` so `req.authMethod` /
 * `req.apiKeyScopes` are set. Session-authenticated requests always pass
 * through unrestricted - scopes only constrain delegated API-key
 * credentials, not the account owner's own session.
 *
 * @param {string} requiredScope One of `API_KEY_SCOPE_NAMES`.
 * @returns {import('express').RequestHandler} Middleware sending 403 when the
 *   caller's API key lacks the required scope.
 */
export function requireApiKeyScope(requiredScope) {
  return function requireApiKeyScopeMiddleware(req, res, next) {
    if (req.authMethod !== "api_key") {
      next();
      return;
    }
    if (scopeSatisfies(req.apiKeyScopes, requiredScope)) {
      next();
      return;
    }
    res.status(403).json({
      error: "insufficient_scope",
      message: `This API key does not have the "${requiredScope}" scope.`,
    });
  };
}
