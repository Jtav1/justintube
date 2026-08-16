import { createHash, randomBytes } from "node:crypto";
import { sequelize } from "../db.js";
import { PasswordResetToken, User } from "../models/index.js";

/**
 * Password reset token lifetime in milliseconds (1 hour) — shorter than the
 * 24h email-verification TTL since a live reset link is more sensitive.
 *
 * @type {number}
 */
export const TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Computes the SHA-256 hex digest of a raw password reset token.
 *
 * @param {string} rawToken Plaintext reset token.
 * @returns {string} Lowercase hex SHA-256 digest.
 */
export function hashResetToken(rawToken) {
  return createHash("sha256").update(String(rawToken), "utf8").digest("hex");
}

/**
 * Creates a fresh password reset token for a user, replacing any prior tokens.
 *
 * @param {number} userId User id to associate with the token.
 * @returns {Promise<string>} Raw token string to send to the user (not stored).
 */
export async function createPasswordResetToken(userId) {
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = hashResetToken(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await PasswordResetToken.destroy({ where: { userId } });
  await PasswordResetToken.create({
    userId,
    tokenHash,
    expiresAt,
  });

  return rawToken;
}

/**
 * Error thrown when a password reset fails with a known client-facing code.
 */
export class PasswordResetError extends Error {
  /**
   * @param {string} code Machine-readable error code.
   * @param {string} message Human-readable message.
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Validates a password reset token and applies a new password hash to the
 * owning user, burning the token in the process (single use).
 *
 * @param {string} rawToken Plaintext token from the client.
 * @param {string} passwordHash Pre-hashed new password (bcrypt).
 * @returns {Promise<import('sequelize').Model>} Updated user instance.
 * @throws {PasswordResetError} When the token is invalid, expired, or the user is missing.
 */
export async function consumePasswordResetToken(rawToken, passwordHash) {
  const trimmed = String(rawToken || "").trim();
  if (!trimmed) {
    throw new PasswordResetError("invalid_body", "token is required.");
  }

  const tokenHash = hashResetToken(trimmed);
  const tokenRow = await PasswordResetToken.findOne({
    where: { tokenHash },
  });

  if (!tokenRow) {
    throw new PasswordResetError("invalid_token", "Invalid reset token.");
  }

  if (new Date(tokenRow.expiresAt).getTime() <= Date.now()) {
    throw new PasswordResetError("token_expired", "Reset token has expired.");
  }

  const user = await User.findByPk(tokenRow.userId);
  if (!user) {
    throw new PasswordResetError("invalid_token", "Invalid reset token.");
  }

  return sequelize.transaction(async (transaction) => {
    await PasswordResetToken.destroy({
      where: { userId: user.id },
      transaction,
    });
    await user.update(
      {
        passwordHash,
        passwordExpired: false,
      },
      { transaction },
    );
    return user;
  });
}
