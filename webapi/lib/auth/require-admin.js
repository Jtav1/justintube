/**
 * Express middleware that requires the authenticated user to have the admin
 * role. Must run after `requireAuth` so `req.authRole` is set.
 *
 * @param {import('express').Request} req Incoming request (`req.authRole` set).
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Continues when the user is admin.
 * @returns {void} Sends 403 when the caller is not an admin.
 */
export function requireAdmin(req, res, next) {
  if (req.authRole?.name !== "admin") {
    res.status(403).json({
      error: "forbidden",
      message: "Admin access required.",
    });
    return;
  }
  next();
}
