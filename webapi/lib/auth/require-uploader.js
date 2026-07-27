/**
 * Express middleware that requires the authenticated user to have the
 * `uploader` flag set. Must run after `requireAuth` so `req.user` is set.
 * Admins bypass the flag (same precedent as `isOwnerOrAdmin` elsewhere).
 *
 * @param {import('express').Request} req Incoming request (`req.user`/`req.authRole` set).
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Continues when the user may upload.
 * @returns {void} Sends 403 when the caller lacks the uploader flag (and isn't admin).
 */
export function requireUploader(req, res, next) {
  if (req.authRole?.name === "admin" || req.user?.uploader) {
    next();
    return;
  }
  res.status(403).json({
    error: "forbidden",
    message: "Uploader access required.",
  });
}
