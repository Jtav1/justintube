/**
 * Express middleware that requires the authenticated user to have the admin
 * or moderator role. Must run after `requireAuth` so `req.authRole` is set.
 *
 * @param {import('express').Request} req Incoming request (`req.authRole` set).
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Continues when the user may moderate.
 * @returns {void} Sends 403 when the caller is not admin or moderator.
 */
export function requireModerator(req, res, next) {
  const roleName = req.authRole?.name;
  if (roleName !== "admin" && roleName !== "moderator") {
    res.status(403).json({
      error: "forbidden",
      message: "Moderator access required.",
    });
    return;
  }
  next();
}
