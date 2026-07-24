import { Op } from "sequelize";
import rateLimit from "express-rate-limit";
import { Router } from "express";
import { hashPassword, verifyPassword } from "../lib/auth/password.js";
import {
  createVerificationToken,
  EmailVerificationError,
  verifyEmailToken,
} from "../lib/auth/email-verification.js";
import {
  emailEnabled,
  sendVerificationEmail,
} from "../lib/email/mailer.js";
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
 * Stricter rate limiter for resend-verification to reduce email abuse.
 *
 * @type {import('express').RequestHandler}
 */
const resendVerificationLimiter = rateLimit({
  windowMs: 60_000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Returns whether public account registration is enabled.
 *
 * @private
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
 * @private
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
 * @private
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
 * @private
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
 * Sends a verification email when email is configured; logs and swallows errors.
 *
 * @private
 * @param {import('sequelize').Model} user User with `id` and `email`.
 * @returns {Promise<void>} Resolves when send completes or fails gracefully.
 */
async function sendUserVerificationEmail(user) {
  if (!emailEnabled()) {
    return;
  }

  try {
    const token = await createVerificationToken(user.id);
    await sendVerificationEmail({ to: user.email, token });
  } catch (err) {
    console.error("Failed to send verification email:", err);
  }
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
   * GET /api/v1/auth/csrf — no body.
   * Auth: none (creates/touches an anonymous session cookie).
   *
   * @openapi
   * /api/v1/auth/csrf:
   *   get:
   *     tags: [Auth]
   *     summary: Issue CSRF token
   *     operationId: authCsrf
   *     responses:
   *       200:
   *         description: CSRF token for subsequent mutating cookie requests
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [csrfToken]
   *               properties:
   *                 csrfToken:
   *                   type: string
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
   * Auth: X-CSRF-Token required. Returns 201 `{ user, csrfToken }`.
   *
   * @openapi
   * /api/v1/auth/register:
   *   post:
   *     tags: [Auth]
   *     summary: Register a local account
   *     operationId: authRegister
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [username, email, password]
   *             properties:
   *               username: { type: string }
   *               email: { type: string, format: email }
   *               password: { type: string, minLength: 8 }
   *               displayName: { type: string, nullable: true }
   *     responses:
   *       201:
   *         description: Account created and session established
   *       403:
   *         description: Registration disabled
   *       409:
   *         description: Username or email already registered
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

      if (needsVerify) {
        await sendUserVerificationEmail(user);
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
   * POST /api/v1/auth/login with { username, password }.
   * Auth: X-CSRF-Token required. Returns `{ user, csrfToken }`.
   *
   * @openapi
   * /api/v1/auth/login:
   *   post:
   *     tags: [Auth]
   *     summary: Log in with username and password
   *     operationId: authLogin
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [username, password]
   *             properties:
   *               username: { type: string }
   *               password: { type: string }
   *     responses:
   *       200:
   *         description: Session established
   *       401:
   *         description: Invalid credentials
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
   * Destroys the current session cookie.
   * POST /api/v1/auth/logout — no body.
   * Auth: X-CSRF-Token required (session cookie clients); Bearer API keys skip CSRF.
   *
   * @openapi
   * /api/v1/auth/logout:
   *   post:
   *     tags: [Auth]
   *     summary: Log out and clear session cookie
   *     operationId: authLogout
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *     responses:
   *       204:
   *         description: Session destroyed
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
   * GET /api/v1/auth/me — no body.
   * Auth: session cookie or Authorization Bearer API key (`requireAuth`).
   *
   * @openapi
   * /api/v1/auth/me:
   *   get:
   *     tags: [Auth]
   *     summary: Current authenticated user
   *     operationId: authMe
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: Public user profile
   *       401:
   *         description: Not authenticated
   *
   * @param {import('express').Request} req Incoming request (`req.user` / `req.authRole` set).
   * @param {import('express').Response} res Express response.
   * @returns {void} Sends the public user object.
   */
  auth.get("/me", requireAuth, (req, res) => {
    res.json(serializeUser(req.user, req.authRole));
  });

  /**
   * Confirms a user's email address using a one-time verification token.
   * POST /api/v1/auth/verify-email with { token }.
   * Auth: none (token is proof); X-CSRF-Token required for cookie clients.
   *
   * @openapi
   * /api/v1/auth/verify-email:
   *   post:
   *     tags: [Auth]
   *     summary: Verify email with a one-time token
   *     operationId: authVerifyEmail
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [token]
   *             properties:
   *               token: { type: string }
   *     responses:
   *       200:
   *         description: Email verified; returns updated user profile
   *       400:
   *         description: Missing or invalid token
   *       409:
   *         description: Email already verified
   *       410:
   *         description: Token expired
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends `{ user }` or an error response.
   */
  auth.post("/verify-email", async (req, res) => {
    try {
      const token = String(req.body?.token || "").trim();
      if (!token) {
        res.status(400).json({
          error: "invalid_body",
          message: "token is required.",
        });
        return;
      }

      const user = await verifyEmailToken(token);
      const role = user.Role || null;
      res.json({ user: serializeUser(user, role) });
    } catch (err) {
      if (err instanceof EmailVerificationError) {
        const statusByCode = {
          invalid_body: 400,
          invalid_token: 400,
          token_expired: 410,
          already_verified: 409,
        };
        const status = statusByCode[err.code] || 400;
        res.status(status).json({
          error: err.code,
          message: err.message,
        });
        return;
      }
      console.error("authVerifyEmail failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Email verification failed.",
      });
    }
  });

  /**
   * Sends a fresh verification email to the authenticated user.
   * POST /api/v1/auth/resend-verification — no body.
   * Auth: session cookie or API key (`requireAuth`); X-CSRF-Token for sessions.
   *
   * @openapi
   * /api/v1/auth/resend-verification:
   *   post:
   *     tags: [Auth]
   *     summary: Resend email verification message
   *     operationId: authResendVerification
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       204:
   *         description: Verification email sent
   *       403:
   *         description: Email already verified
   *       503:
   *         description: Email capability disabled
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 204 or an error response.
   */
  auth.post(
    "/resend-verification",
    resendVerificationLimiter,
    requireAuth,
    async (req, res) => {
      try {
        if (req.user.emailVerified) {
          res.status(403).json({
            error: "already_verified",
            message: "Email is already verified.",
          });
          return;
        }

        if (!emailEnabled()) {
          res.status(503).json({
            error: "email_disabled",
            message: "Email is not configured.",
          });
          return;
        }

        await sendUserVerificationEmail(req.user);
        res.status(204).end();
      } catch (err) {
        console.error("authResendVerification failed:", err);
        res.status(500).json({
          error: "internal_error",
          message: "Failed to resend verification email.",
        });
      }
    },
  );

  /**
   * Changes the authenticated user's password (session cookie only).
   * POST /api/v1/auth/password with { currentPassword, newPassword }.
   * Auth: session cookie; X-CSRF-Token required.
   *
   * @openapi
   * /api/v1/auth/password:
   *   post:
   *     tags: [Auth]
   *     summary: Change account password
   *     operationId: authChangePassword
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *     security:
   *       - cookieAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [currentPassword, newPassword]
   *             properties:
   *               currentPassword: { type: string }
   *               newPassword: { type: string, minLength: 8 }
   *     responses:
   *       204:
   *         description: Password updated
   *       401:
   *         description: Current password incorrect
   *       403:
   *         description: Password not set or API key auth not allowed
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 204 or an error response.
   */
  auth.post("/password", requireAuth, async (req, res) => {
    try {
      if (req.authMethod !== "session") {
        res.status(403).json({
          error: "session_required",
          message: "Password change requires a session cookie.",
        });
        return;
      }

      const currentPassword = String(req.body?.currentPassword || "");
      const newPassword = String(req.body?.newPassword || "");

      if (!currentPassword || !newPassword) {
        res.status(400).json({
          error: "invalid_body",
          message: "currentPassword and newPassword are required.",
        });
        return;
      }

      if (!req.user.passwordHash) {
        res.status(403).json({
          error: "password_not_set",
          message: "This account does not have a local password.",
        });
        return;
      }

      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        res.status(400).json({
          error: "invalid_password",
          message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        });
        return;
      }

      const currentOk = await verifyPassword(
        currentPassword,
        req.user.passwordHash,
      );
      if (!currentOk) {
        res.status(401).json({
          error: "invalid_credentials",
          message: "Current password is incorrect.",
        });
        return;
      }

      const passwordHash = await hashPassword(newPassword);
      await req.user.update({ passwordHash });
      res.status(204).end();
    } catch (err) {
      console.error("authChangePassword failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Password change failed.",
      });
    }
  });

  // Mount under /auth so CSRF middleware does not apply to other /api/v1 routes.
  router.use("/auth", auth);
  return router;
}

