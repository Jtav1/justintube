import nodemailer from "nodemailer";
import { TOKEN_TTL_MS as PASSWORD_RESET_TOKEN_TTL_MS } from "../auth/password-reset.js";
import { logger } from "../logger.js";

/** @type {import("nodemailer").Transporter|null} */
let cachedTransport = null;

/**
 * Returns whether outbound email is configured (SMTP host and from address set).
 *
 * @returns {boolean} True when email sending is available.
 */
export function emailEnabled() {
  const host = String(process.env.SMTP_HOST || "").trim();
  const from = String(process.env.MAIL_FROM_ADDRESS || "").trim();
  return Boolean(host && from);
}

/**
 * Returns whether admins should be emailed when a new user completes email
 * verification (ENABLE_ADMIN_NEW_USER_NOTIFICATIONS). Independent of
 * `emailEnabled()` — both must be true for a notification to actually send.
 *
 * @returns {boolean} True when the feature is enabled.
 */
export function adminNewUserNotificationsEnabled() {
  return String(process.env.ENABLE_ADMIN_NEW_USER_NOTIFICATIONS || "").toLowerCase() === "true";
}

/**
 * Escapes HTML metacharacters in a string bound for interpolation into an
 * HTML email body. Usernames/emails are user-supplied, so this must run on
 * anything from a USERS row before it lands in `htmlBody`.
 *
 * @private
 * @param {unknown} value Raw value to escape.
 * @returns {string} HTML-safe text.
 */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Matches `[label](/relative/path)` markdown-style links, as embedded by
 * notification messages that need in-app hyperlinks (e.g. the duplicate-
 * upload admin notification in `webapi/routes/internal-original-uploads.js`
 * - see `NotificationItem`/`parseNotificationMessage` in the webview, which
 * render the same syntax as clickable `<Link>`s).
 *
 * @type {RegExp}
 */
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\((\/[^)]*)\)/g;

/**
 * Converts a notification message's markdown-style links into
 * `"label (https://absolute/url)"` for the plain-text email body. A link
 * whose path can't be resolved to an absolute URL (PUBLIC_APP_URL unset)
 * falls back to just its label.
 *
 * @private
 * @param {string} message Raw notification message, possibly containing
 *   `[label](/path)` links.
 * @returns {string} Plain-text message with links spelled out inline.
 */
function messageToPlainText(message) {
  return message.replace(MARKDOWN_LINK_PATTERN, (_match, label, path) => {
    const absolute = buildPublicLink(path);
    return absolute ? `${label} (${absolute})` : label;
  });
}

/**
 * Converts a notification message's markdown-style links into real `<a>`
 * tags for the HTML email body, HTML-escaping everything else (message
 * text can come from user-supplied content, e.g. a moderator's note).
 *
 * @private
 * @param {string} message Raw notification message, possibly containing
 *   `[label](/path)` links.
 * @returns {string} HTML-safe message with links rendered as `<a>` tags.
 */
function messageToHtml(message) {
  let html = "";
  let lastIndex = 0;
  let match;
  MARKDOWN_LINK_PATTERN.lastIndex = 0;
  while ((match = MARKDOWN_LINK_PATTERN.exec(message)) !== null) {
    html += escapeHtml(message.slice(lastIndex, match.index));
    const absolute = buildPublicLink(match[2]);
    html += absolute
      ? `<a href="${escapeHtml(absolute)}">${escapeHtml(match[1])}</a>`
      : escapeHtml(match[1]);
    lastIndex = MARKDOWN_LINK_PATTERN.lastIndex;
  }
  html += escapeHtml(message.slice(lastIndex));
  return html;
}

/**
 * Parses SMTP_SECURE env as a boolean (defaults to false). Must be exactly
 * "true" or "false" — nodemailer's `secure` option controls implicit TLS on
 * connect (port 465), not STARTTLS (port 587), so values like "TLS" do not
 * mean what they look like they mean and are flagged rather than silently
 * treated as false.
 *
 * @private
 * @returns {boolean} True when implicit TLS should be used on connect.
 */
function smtpSecure() {
  const raw = String(process.env.SMTP_SECURE || "").trim();
  const normalized = raw.toLowerCase();
  if (raw && normalized !== "true" && normalized !== "false") {
    logger.error(
      `smtpSecure: SMTP_SECURE="${raw}" is not "true" or "false" and will be treated as false` +
        " (STARTTLS on connect, correct for most port 587 setups). See .env.example for guidance.",
    );
  }
  return normalized === "true";
}

/**
 * Returns a lazily created nodemailer transport from SMTP env vars.
 *
 * @private
 * @returns {import("nodemailer").Transporter} Configured SMTP transport.
 */
function getTransport() {
  if (!cachedTransport) {
    if (process.env.NODE_ENV === "test") {
      cachedTransport = nodemailer.createTransport({ jsonTransport: true });
      return cachedTransport;
    }

    const portRaw = String(process.env.SMTP_PORT || "").trim();
    const port = portRaw ? Number(portRaw) : 587;
    cachedTransport = nodemailer.createTransport({
      host: String(process.env.SMTP_HOST || "").trim(),
      port: Number.isFinite(port) ? port : 587,
      secure: smtpSecure(),
      auth:
        process.env.SMTP_USERNAME || process.env.SMTP_PASSWORD
          ? {
              user: String(process.env.SMTP_USERNAME || ""),
              pass: String(process.env.SMTP_PASSWORD || ""),
            }
          : undefined,
    });
  }
  return cachedTransport;
}

/**
 * Builds the verification link or fallback token text for email bodies.
 *
 * @private
 * @param {string} token Raw verification token.
 * @returns {{ link: string|null, tokenLine: string }} Link and plain-token fallback text.
 */
function verificationLinkContent(token) {
  const publicUrl = String(process.env.PUBLIC_APP_URL || "").trim().replace(/\/$/, "");
  if (publicUrl) {
    return {
      link: `${publicUrl}/verify-email?token=${encodeURIComponent(token)}`,
      tokenLine: "",
    };
  }
  return {
    link: null,
    tokenLine: `Your verification token is: ${token}`,
  };
}

/**
 * Sends an email verification message to a user.
 *
 * @param {object} params Recipient and token details.
 * @param {string} params.to Recipient email address.
 * @param {string} params.token Raw verification token (included in link or body).
 * @returns {Promise<void>} Resolves when the message has been accepted by SMTP.
 * @throws {Error} When email is disabled or SMTP delivery fails.
 */
export async function sendVerificationEmail({ to, token }) {
  if (!emailEnabled()) {
    throw new Error("Email is not configured.");
  }

  const from = String(process.env.MAIL_FROM_ADDRESS || "").trim();
  const { link, tokenLine } = verificationLinkContent(token);

  if (!link) {
    logger.error(
      "sendVerificationEmail: PUBLIC_APP_URL is not configured, so the verification email will be" +
        " sent without a usable link. Set PUBLIC_APP_URL so recipients can complete verification.",
    );
  }

  const textLines = [
    "Verify your Justintube account email address.",
    "",
    link
      ? `Click the link below to verify your email, or copy and paste it into your web browser:\n${link}`
      : tokenLine,
    "",
    "This link expires in 24 hours. If you did not create an account, you can ignore this message.",
  ];

  const htmlBody = link
    ? `<p>Verify your Justintube account email address.</p>` +
      `<p>Click the link below to verify your email, or copy and paste it into your web browser:</p>` +
      `<p><a href="${link}">Verify email</a></p>` +
      `<p>${link}</p>` +
      `<p>This link expires in 24 hours.</p>`
    : `<p>Verify your Justintube account email address.</p><p>${tokenLine}</p><p>This token expires in 24 hours.</p>`;

  await getTransport().sendMail({
    from,
    to,
    subject: "Verify your Justintube email",
    text: textLines.join("\n"),
    html: htmlBody,
  });
}

/**
 * Builds the password reset link or fallback token text for email bodies.
 *
 * @private
 * @param {string} token Raw password reset token.
 * @returns {{ link: string|null, tokenLine: string }} Link and plain-token fallback text.
 */
function resetPasswordLinkContent(token) {
  const publicUrl = String(process.env.PUBLIC_APP_URL || "").trim().replace(/\/$/, "");
  if (publicUrl) {
    return {
      link: `${publicUrl}/reset-password?token=${encodeURIComponent(token)}`,
      tokenLine: "",
    };
  }
  return {
    link: null,
    tokenLine: `Your password reset token is: ${token}`,
  };
}

/**
 * Sends a password reset message to a user.
 *
 * @param {object} params Recipient and token details.
 * @param {string} params.to Recipient email address.
 * @param {string} params.token Raw password reset token (included in link or body).
 * @returns {Promise<void>} Resolves when the message has been accepted by SMTP.
 * @throws {Error} When email is disabled or SMTP delivery fails.
 */
export async function sendPasswordResetEmail({ to, token }) {
  if (!emailEnabled()) {
    throw new Error("Email is not configured.");
  }

  const from = String(process.env.MAIL_FROM_ADDRESS || "").trim();
  const { link, tokenLine } = resetPasswordLinkContent(token);
  const ttlHours = Math.round(PASSWORD_RESET_TOKEN_TTL_MS / (60 * 60 * 1000));

  if (!link) {
    logger.error(
      "sendPasswordResetEmail: PUBLIC_APP_URL is not configured, so the reset email will be" +
        " sent without a usable link. Set PUBLIC_APP_URL so recipients can complete the reset.",
    );
  }

  const textLines = [
    "A password reset was requested for your Justintube account.",
    "",
    link
      ? `Click the link below to reset your password, or copy and paste it into your web browser:\n${link}`
      : tokenLine,
    "",
    `This link expires in ${ttlHours} hour(s). If you did not request this, you can ignore this message.`,
  ];

  const htmlBody = link
    ? `<p>A password reset was requested for your Justintube account.</p>` +
      `<p>Click the link below to reset your password, or copy and paste it into your web browser:</p>` +
      `<p><a href="${link}">Reset password</a></p>` +
      `<p>${link}</p>` +
      `<p>This link expires in ${ttlHours} hour(s).</p>`
    : `<p>A password reset was requested for your Justintube account.</p><p>${tokenLine}</p><p>This token expires in ${ttlHours} hour(s).</p>`;

  await getTransport().sendMail({
    from,
    to,
    subject: "Reset your Justintube password",
    text: textLines.join("\n"),
    html: htmlBody,
  });
}

/**
 * Sends a "new user registered" notification to admins after a user
 * completes email verification. Recipients are BCC'd together so admins
 * don't see each other's addresses; the visible `to` is the sending address
 * itself, which every SMTP relay accepts as a normal recipient.
 *
 * @param {object} params Recipient and new-user details.
 * @param {string[]} params.adminEmails Admin email addresses to notify.
 * @param {{username: string, email: string, displayName?: string|null}} params.newUser
 *   The user who just completed verification.
 * @returns {Promise<void>} Resolves when the message has been accepted by SMTP.
 * @throws {Error} When email is disabled, no admin emails are given, or SMTP delivery fails.
 */
export async function sendNewUserAdminNotification({ adminEmails, newUser }) {
  if (!emailEnabled()) {
    throw new Error("Email is not configured.");
  }
  if (!adminEmails || adminEmails.length === 0) {
    throw new Error("No admin email addresses were given.");
  }

  const from = String(process.env.MAIL_FROM_ADDRESS || "").trim();
  const publicUrl = String(process.env.PUBLIC_APP_URL || "").trim().replace(/\/$/, "");
  const profileLink = publicUrl
    ? `${publicUrl}/users/${encodeURIComponent(newUser.username)}`
    : null;

  const textLines = [
    `A new user just verified their email address: ${newUser.username} (${newUser.email}).`,
    "",
    profileLink ? `View their profile: ${profileLink}` : null,
  ].filter((line) => line !== null);

  const htmlBody = `<p>A new user just verified their email address: ` +
    `<strong>${escapeHtml(newUser.username)}</strong> (${escapeHtml(newUser.email)}).</p>` +
    (profileLink ? `<p><a href="${profileLink}">${profileLink}</a></p>` : "");

  await getTransport().sendMail({
    from,
    to: from,
    bcc: adminEmails.join(", "),
    subject: `New user registered: ${newUser.username}`,
    text: textLines.join("\n"),
    html: htmlBody,
  });
}

/**
 * Builds an absolute link into the frontend from a path, using
 * `PUBLIC_APP_URL`. Shared by any email that needs to link somewhere in the
 * app (verification, notifications, ...) so the "is PUBLIC_APP_URL
 * configured, strip the trailing slash" logic lives in one place.
 *
 * @param {string} path App-relative path, including its leading slash
 *   (e.g. `/video?v=abc123`).
 * @returns {string|null} Absolute URL, or null when `PUBLIC_APP_URL` is unset.
 */
export function buildPublicLink(path) {
  const publicUrl = String(process.env.PUBLIC_APP_URL || "").trim().replace(/\/$/, "");
  return publicUrl ? `${publicUrl}${path}` : null;
}

/**
 * Sends a generic notification email - the delivery mechanism behind
 * `lib/notifications.js`'s `createNotification`, usable for any
 * notification type regardless of what (if anything) it links to. Callers
 * are responsible for building `link` (e.g. via `buildPublicLink`) since
 * the mapping from a notification's data to a URL is type-specific.
 *
 * @param {object} params Recipient and content details.
 * @param {string} params.to Recipient email address.
 * @param {string} params.title Email subject, and lead line of the body.
 * @param {string} params.message Notification message body text.
 * @param {string|null} [params.link] Absolute URL to include in the email, if any.
 * @returns {Promise<void>} Resolves when the message has been accepted by SMTP.
 * @throws {Error} When email is disabled or SMTP delivery fails.
 */
export async function sendNotificationEmail({ to, title, message, link = null }) {
  if (!emailEnabled()) {
    throw new Error("Email is not configured.");
  }

  const from = String(process.env.MAIL_FROM_ADDRESS || "").trim();
  const publicUrl = String(process.env.PUBLIC_APP_URL || "").trim().replace(/\/$/, "");
  const signature = `- justintube (<${publicUrl}>)`;

  const textLines = [messageToPlainText(message), "", link ? `View it here: ${link}` : null].filter(
    (line) => line !== null,
  );
  const text = `${textLines.join("\n")}\n${signature}`;
  const htmlBody =
    `<p>${messageToHtml(message)}</p>` +
    (link ? `<p><a href="${link}">${link}</a></p>` : "") +
    `<p>${escapeHtml(signature)}</p>`;

  await getTransport().sendMail({
    from,
    to,
    subject: title,
    text,
    html: htmlBody,
  });
}

/**
 * Sends a single digest email summarizing multiple outstanding notifications
 * at once - the delivery mechanism behind the periodic digest cron
 * (`lib/notification-email-digest.js`), which batches "like"/"comment"/
 * "subscription" notifications instead of emailing each one immediately.
 *
 * @param {object} params Recipient and content details.
 * @param {string} params.to Recipient email address.
 * @param {{title: string, message: string}[]} params.notifications
 *   Notifications to list in the email (already capped by the caller, e.g.
 *   to 20 per email - this function lists exactly what it's given).
 * @param {number} params.totalCount Total outstanding notification count
 *   this digest is for, which may exceed `notifications.length` when more
 *   were left for a future run; used for the subject line and an "...and N
 *   more" footer.
 * @param {string|null} [params.link] Absolute URL to the notifications page, if any.
 * @returns {Promise<void>} Resolves when the message has been accepted by SMTP.
 * @throws {Error} When email is disabled or SMTP delivery fails.
 */
export async function sendNotificationDigestEmail({ to, notifications, totalCount, link = null }) {
  if (!emailEnabled()) {
    throw new Error("Email is not configured.");
  }

  const from = String(process.env.MAIL_FROM_ADDRESS || "").trim();
  const publicUrl = String(process.env.PUBLIC_APP_URL || "").trim().replace(/\/$/, "");
  const signature = `- justintube (<${publicUrl}>)`;
  const overflow = totalCount - notifications.length;
  const subject =
    totalCount === 1 ? "You have a new notification" : `You have ${totalCount} new notifications`;

  const textLines = [
    `${subject}:`,
    "",
    ...notifications.map((n) => `- ${n.title}: ${messageToPlainText(n.message)}`),
    overflow > 0 ? `...and ${overflow} more.` : null,
    "",
    link ? `View all notifications: ${link}` : null,
  ].filter((line) => line !== null);
  const text = `${textLines.join("\n")}\n${signature}`;

  const htmlItems = notifications
    .map((n) => `<li><strong>${escapeHtml(n.title)}</strong>: ${messageToHtml(n.message)}</li>`)
    .join("");
  const htmlBody =
    `<p>${escapeHtml(subject)}:</p>` +
    `<ul>${htmlItems}</ul>` +
    (overflow > 0 ? `<p>...and ${overflow} more.</p>` : "") +
    (link ? `<p><a href="${link}">View all notifications</a></p>` : "") +
    `<p>${escapeHtml(signature)}</p>`;

  await getTransport().sendMail({
    from,
    to,
    subject,
    text,
    html: htmlBody,
  });
}

/**
 * Resets the cached transport (for tests).
 *
 * @returns {void} No return value.
 */
export function resetMailerForTests() {
  cachedTransport = null;
}
