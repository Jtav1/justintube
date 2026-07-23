import { Op } from "sequelize";
import rateLimit from "express-rate-limit";
import { Router } from "express";
import { hashPassword, verifyPassword } from "../lib/auth/password.js";
import {
  csrfProtection,
  ensureCsrfToken,
  rotateCsrfToken,
} from "../lib/auth/csrf.js";
import { requireAuth } from "../lib/auth/require-auth.js";
import { serializeUser } from "../lib/auth/serialize-user.js";
import {
  destroySession,
  regenerateSession,
  saveSession,
} from "../lib/auth/session.js";
import { Role, User } from "../lib/models/index.js";

/**
 * Minimum accepted password length for register/login validation.
 *
 * @type {number}
 */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Stricter rate limiter for credential endpoints (register / login).
 *
 * @type {import('express').RequestHandler}
 */
const authCredentialLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Returns whether public account registration is enabled.
 *
 * @returns {boolean} True when ENABLE_ACCOUNT_REGISTRATION is the string "true".
 */
function registrationEnabled() {
  return (
    String(process.env.ENABLE_ACCOUNT_REGISTRATION || "").toLowerCase() ===
    "true"
  );
}

/**
 * Returns whether new accounts require email verification before full access.
 *
 * @returns {boolean} True when REQUIRE_EMAIL_VERIFICATION is the string "true".
 */
function requireEmailVerification() {
  return (
    String(process.env.REQUIRE_EMAIL_VERIFICATION || "").toLowerCase() ===
    "true"
  );
}

/**
 * Establishes an authenticated session for a user after regenerating the
 * session id (session-fixation mitigation) and rotating the CSRF token.
 *
 * @param {import('express').Request} req Incoming request.
 * @param {number} userId Authenticated user's id.
 * @returns {Promise<string>} Fresh CSRF token for the new session.
 */
async function establishSession(req, userId) {
  await regenerateSession(req);
  req.session.userId = userId;
  const csrfToken = rotateCsrfToken(req);
  await saveSession(req);
  return csrfToken;
}

/**
 * Loads a user with their Role by username.
 *
 * @param {string} username Account username.
 * @returns {Promise<import('sequelize').Model|null>} User instance or null.
 */
async function findUserByUsername(username) {
  return User.findOne({
    where: { username },
    include: [{ model: Role, required: false }],
  });
}

/**
 * Builds the `/auth` router (mounted under `/api/v1`).
 *
 * @returns {import('express').Router} Configured auth router.
 */
export function createAuthRouter() {
  const router = Router();
  const auth = Router();
  auth.use(csrfProtection);

  /**
   * Issues (or returns) a CSRF token for the current session.
   * GET /api/v1/auth/csrf — no auth required.
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends `{ csrfToken }`.
   */
  auth.get("/csrf", async (req, res) => {
    try {
      // saveUninitialized is false; touch the session so the CSRF cookie exists.
      const csrfToken = ensureCsrfToken(req);
      await saveSession(req);
      res.json({ csrfToken });
    } catch (err) {
      console.error("authCsrf failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to issue CSRF token.",
      });
    }
  });

  /**
   * Registers a new local account when registration is enabled.
   * POST /api/v1/auth/register with { username, email, password, displayName? }.
   * Requires X-CSRF-Token. Returns 201 `{ user, csrfToken }`.
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends created user or an error response.
   */
  auth.post("/register", authCredentialLimiter, async (req, res) => {
    try {
      if (!registrationEnabled()) {
        res.status(403).json({
          error: "registration_disabled",
          message: "Account registration is disabled.",
        });
        return;
      }

      const username = String(req.body?.username || "").trim();
      const email = String(req.body?.email || "").trim().toLowerCase();
      const password = String(req.body?.password || "");
      const displayNameRaw = req.body?.displayName;
      const displayName =
        displayNameRaw === undefined || displayNameRaw === null
          ? null
          : String(displayNameRaw).trim() || null;

      if (!username || !email || !password) {
        res.status(400).json({
          error: "invalid_body",
          message: "username, email, and password are required.",
        });
        return;
      }

      if (password.length < MIN_PASSWORD_LENGTH) {
        res.status(400).json({
          error: "invalid_password",
          message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        });
        return;
      }

      const duplicate = await User.findOne({
        where: {
          [Op.or]: [{ username }, { email }],
        },
      });
      if (duplicate) {
        res.status(409).json({
          error: "conflict",
          message: "Username or email is already registered.",
        });
        return;
      }

      const needsVerify = requireEmailVerification();
      const roleName = needsVerify ? "unverified" : "viewer";
      const role = await Role.findOne({ where: { name: roleName } });
      const passwordHash = await hashPassword(password);

      const user = await User.create({
        username,
        email,
        displayName,
        passwordHash,
        emailVerified: !needsVerify,
        emailVerifiedAt: needsVerify ? null : new Date(),
        uploader: false,
        roleId: role ? role.id : null,
      });

      if (role) {
        user.Role = role;
      }

      const csrfToken = await establishSession(req, user.id);
      res.status(201).json({
        user: serializeUser(user, role),
        csrfToken,
      });
    } catch (err) {
      console.error("authRegister failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Registration failed.",
      });
    }
  });

  /**
   * Authenticates with username and password, establishing a cookie session.
   * POST /api/v1/auth/login with { username, password }. Requires X-CSRF-Token.
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends `{ user, csrfToken }` or an error response.
   */
  auth.post("/login", authCredentialLimiter, async (req, res) => {
    try {
      const username = String(req.body?.username || "").trim();
      const password = String(req.body?.password || "");

      if (!username || !password) {
        res.status(400).json({
          error: "invalid_body",
          message: "username and password are required.",
        });
        return;
      }

      const user = await findUserByUsername(username);
      const passwordOk = user
        ? await verifyPassword(password, user.passwordHash)
        : false;

      if (!user || !passwordOk) {
        res.status(401).json({
          error: "invalid_credentials",
          message: "Invalid username or password.",
        });
        return;
      }

      const role = user.Role || null;
      if (role && role.name === "locked") {
        res.status(401).json({
          error: "invalid_credentials",
          message: "Invalid username or password.",
        });
        return;
      }

      const csrfToken = await establishSession(req, user.id);
      res.json({
        user: serializeUser(user, role),
        csrfToken,
      });
    } catch (err) {
      console.error("authLogin failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Login failed.",
      });
    }
  });

  /**
   * Destroys the current session cookie. POST /api/v1/auth/logout.
   * Requires X-CSRF-Token when a session cookie is present.
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 204 No Content.
   */
  auth.post("/logout", async (req, res) => {
    try {
      await destroySession(req);
      res.clearCookie("justintube.sid");
      res.status(204).end();
    } catch (err) {
      console.error("authLogout failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Logout failed.",
      });
    }
  });

  /**
   * Returns the authenticated user's public profile.
   * GET /api/v1/auth/me — session cookie or Bearer API key.
   *
   * @param {import('express').Request} req Incoming request (req.user set).
   * @param {import('express').Response} res Express response.
   * @returns {void} Sends the public user object.
   */
  auth.get("/me", requireAuth, (req, res) => {
    res.json(serializeUser(req.user, req.authRole));
  });

  // Mount under /auth so CSRF middleware does not apply to other /api/v1 routes.
  router.use("/auth", auth);
  return router;
}

