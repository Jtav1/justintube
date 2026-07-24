import nodemailer from "nodemailer";

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
 * Parses SMTP_SECURE env as a boolean (defaults to false).
 *
 * @private
 * @returns {boolean} True when TLS should be used on connect.
 */
function smtpSecure() {
  return String(process.env.SMTP_SECURE || "").toLowerCase() === "true";
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

  const textLines = [
    "Verify your Justintube account email address.",
    "",
    link
      ? `Open this link to verify your email:\n${link}`
      : tokenLine,
    "",
    "This link expires in 24 hours. If you did not create an account, you can ignore this message.",
  ];

  const htmlBody = link
    ? `<p>Verify your Justintube account email address.</p><p><a href="${link}">Verify email</a></p><p>This link expires in 24 hours.</p>`
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
 * Resets the cached transport (for tests).
 *
 * @returns {void} No return value.
 */
export function resetMailerForTests() {
  cachedTransport = null;
}
