import { createHash, randomBytes } from "node:crypto";
import { sequelize } from "../db.js";
import {
  EmailVerificationToken,
  Role,
  User,
} from "../models/index.js";

/**
 * Default verification token lifetime in milliseconds (24 hours).
 *
 * @type {number}
 */
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Computes the SHA-256 hex digest of a raw verification token.
 *
 * @param {string} rawToken Plaintext verification token.
 * @returns {string} Lowercase hex SHA-256 digest.
 */
export function hashVerificationToken(rawToken) {
  return createHash("sha256").update(String(rawToken), "utf8").digest("hex");
}

/**
 * Marks a user as email-verified. Verification is tracked independently of
 * role — `roleId` is never touched here; a user keeps whatever role they had
 * regardless of verification status.
 *
 * @param {import('sequelize').Model} user User instance to update.
 * @param {import('sequelize').Transaction} [transaction] Optional Sequelize transaction.
 * @returns {Promise<import('sequelize').Model>} Reloaded user with Role included.
 */
export async function markUserVerified(user, transaction) {
  await user.update(
    {
      emailVerified: true,
      emailVerifiedAt: new Date(),
    },
    { transaction },
  );

  return User.findByPk(user.id, {
    include: [{ model: Role, required: false }],
    transaction,
  });
}

/**
 * Creates a fresh verification token for a user, replacing any prior tokens.
 *
 * @param {number} userId User id to associate with the token.
 * @returns {Promise<string>} Raw token string to send to the user (not stored).
 */
export async function createVerificationToken(userId) {
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = hashVerificationToken(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await EmailVerificationToken.destroy({ where: { userId } });
  await EmailVerificationToken.create({
    userId,
    tokenHash,
    expiresAt,
  });

  return rawToken;
}

/**
 * Error thrown when email verification fails with a known client-facing code.
 */
export class EmailVerificationError extends Error {
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
 * Validates a verification token and marks the owning user as verified.
 *
 * @param {string} rawToken Plaintext token from the client.
 * @returns {Promise<import('sequelize').Model>} Verified user with Role loaded.
 * @throws {EmailVerificationError} When the token is invalid, expired, or user already verified.
 */
export async function verifyEmailToken(rawToken) {
  const trimmed = String(rawToken || "").trim();
  if (!trimmed) {
    throw new EmailVerificationError(
      "invalid_body",
      "token is required.",
    );
  }

  const tokenHash = hashVerificationToken(trimmed);
  const tokenRow = await EmailVerificationToken.findOne({
    where: { tokenHash },
  });

  if (!tokenRow) {
    throw new EmailVerificationError(
      "invalid_token",
      "Invalid verification token.",
    );
  }

  if (new Date(tokenRow.expiresAt).getTime() <= Date.now()) {
    throw new EmailVerificationError(
      "token_expired",
      "Verification token has expired.",
    );
  }

  const user = await User.findByPk(tokenRow.userId, {
    include: [{ model: Role, required: false }],
  });

  if (!user) {
    throw new EmailVerificationError(
      "invalid_token",
      "Invalid verification token.",
    );
  }

  if (user.emailVerified) {
    throw new EmailVerificationError(
      "already_verified",
      "Email is already verified.",
    );
  }

  return sequelize.transaction(async (transaction) => {
    await EmailVerificationToken.destroy({
      where: { userId: user.id },
      transaction,
    });
    return markUserVerified(user, transaction);
  });
}
