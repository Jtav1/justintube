import { EmojiReactionUsage } from "../models/index.js";
import { sequelize } from "../db.js";
import { logger } from "../logger.js";

/**
 * The reaction bar's starting six, seeded so a fresh install looks the same as
 * before this feature and then evolves with usage. Also the fallback the API
 * falls back on if the table is somehow empty.
 *
 * @type {string[]}
 */
export const DEFAULT_REACTION_EMOJI = ["👍", "😂", "😮", "❤️", "🎉", "👎"];

/**
 * Longest accepted reaction, in UTF-16 code units. Generous enough for ZWJ
 * sequences (👨‍👩‍👧‍👦 is 11) while still bounding what gets stored and
 * broadcast.
 *
 * @type {number}
 */
const MAX_EMOJI_LENGTH = 32;

/**
 * Matches exactly one RGI emoji - including ZWJ sequences, flags and skin-tone
 * modifiers - and nothing else. The `v` flag needs Node 20+, which this service
 * already requires.
 *
 * @type {RegExp}
 */
const SINGLE_EMOJI = /^\p{RGI_Emoji}$/v;

/**
 * Whether a client-supplied reaction is a single, real emoji.
 *
 * This replaces an older `slice(0, 8)` truncation in lib/cast/realtime.js,
 * which both corrupted longer emoji and let arbitrary text through to every
 * member's screen. Reactions are broadcast to everyone in a session, so the
 * value has to be validated rather than merely shortened.
 *
 * @param {unknown} raw Client-supplied emoji.
 * @returns {boolean} True when it is one emoji within the length cap.
 */
export function isReactionEmoji(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_EMOJI_LENGTH) {
    return false;
  }
  return SINGLE_EMOJI.test(raw);
}

/**
 * Records one use of an emoji, creating its row on first use.
 *
 * Never throws: a reaction is a live, user-visible broadcast, and failing it
 * because a counter write failed would be a bad trade. Callers may ignore the
 * returned promise.
 *
 * @param {string} emoji A value already accepted by {@link isReactionEmoji}.
 * @returns {Promise<void>} Resolves once recorded (or once the failure is logged).
 */
export async function recordEmojiUse(emoji) {
  try {
    const [row, created] = await EmojiReactionUsage.findOrCreate({
      where: { emoji },
      defaults: { emoji, useCount: 1, lastUsedAt: new Date() },
    });
    if (!created) {
      await row.update({
        useCount: sequelize.literal("use_count + 1"),
        lastUsedAt: new Date(),
      });
    }
  } catch (err) {
    logger.warn({ err, emoji }, "[emoji-usage] failed to record reaction use");
  }
}

/**
 * The instance's most-used reaction emoji, highest first.
 *
 * @param {number} limit How many to return.
 * @returns {Promise<string[]>} Emoji, padded out with the defaults if there
 *   aren't enough recorded yet so the bar is never short.
 */
export async function topReactionEmoji(limit) {
  const rows = await EmojiReactionUsage.findAll({
    attributes: ["emoji"],
    order: [
      ["useCount", "DESC"],
      ["lastUsedAt", "DESC"],
    ],
    limit,
    raw: true,
  });

  const emoji = rows.map((row) => row.emoji);
  for (const fallback of DEFAULT_REACTION_EMOJI) {
    if (emoji.length >= limit) {
      break;
    }
    if (!emoji.includes(fallback)) {
      emoji.push(fallback);
    }
  }
  return emoji.slice(0, limit);
}
