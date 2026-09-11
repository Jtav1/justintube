/**
 * Express middleware that requires the authenticated user to have both the
 * `uploader` flag and a verified email. Must run after `requireAuth` so
 * `req.user` is set. Admins bypass both checks (same precedent as
 * `isOwnerOrAdmin` elsewhere).
 *
 * @param {import('express').Request} req Incoming request (`req.user`/`req.authRole` set).
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Continues when the user may upload.
 * @returns {void} Sends 403 when the caller isn't an admin and lacks the uploader flag
 *   or email verification.
 */
export function requireUploader(req, res, next) {
  if (req.authRole?.name === "admin" || (req.user?.uploader && req.user?.emailVerified)) {
    next();
    return;
  }
  res.status(403).json({
    error: "forbidden",
    message: "Uploader access and a verified email are required.",
  });
}
