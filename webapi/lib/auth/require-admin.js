/**
 * Express middleware that requires the authenticated user to hold the admin
 * role. Must run after `requireAuth` so `req.authRole` is populated.
 *
 * @param {import('express').Request} req Incoming request with auth context.
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Continues when the user is an admin.
 * @returns {void} Sends 403 when the caller is not an admin.
 */
export function requireAdmin(req, res, next) {
  if (req.authRole?.name === "admin") {
    next();
    return;
  }

  res.status(403).json({
    error: "forbidden",
    message: "Admin access required.",
  });
}
