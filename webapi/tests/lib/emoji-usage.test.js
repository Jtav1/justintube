import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import {
  DEFAULT_REACTION_EMOJI,
  isReactionEmoji,
  recordEmojiUse,
  topReactionEmoji,
} from "../../lib/cast/emoji-usage.js";
import { EmojiReactionUsage } from "../../lib/models/index.js";
import { resetTables, setupSchema } from "../helpers/db.js";

/**
 * Unit tests for the reaction-emoji usage tally backing the CAST reaction bar
 * (lib/cast/emoji-usage.js).
 */
describe("cast emoji usage (lib/cast/emoji-usage.js)", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  describe("isReactionEmoji", () => {
    test("accepts multi-codepoint emoji the old slice(0, 8) truncation corrupted", () => {
      // 11 and 6 UTF-16 code units respectively - both were silently mangled
      // by the previous length-based handling in lib/cast/realtime.js.
      expect("👨‍👩‍👧‍👦".length).toBeGreaterThan(8);
      expect(isReactionEmoji("👨‍👩‍👧‍👦")).toBe(true);
      expect(isReactionEmoji("🏳️‍🌈")).toBe(true);
      expect(isReactionEmoji("👍🏽")).toBe(true);
    });

    test("accepts each seeded default", () => {
      for (const emoji of DEFAULT_REACTION_EMOJI) {
        expect(isReactionEmoji(emoji)).toBe(true);
      }
    });

    test("rejects text, markup, empty input and non-strings", () => {
      expect(isReactionEmoji("hello")).toBe(false);
      expect(isReactionEmoji("<script>")).toBe(false);
      expect(isReactionEmoji("")).toBe(false);
      expect(isReactionEmoji(null)).toBe(false);
      expect(isReactionEmoji(undefined)).toBe(false);
      expect(isReactionEmoji(42)).toBe(false);
    });

    test("rejects more than one emoji and over-long input", () => {
      expect(isReactionEmoji("😂😂")).toBe(false);
      expect(isReactionEmoji("😂".repeat(20))).toBe(false);
    });
  });

  describe("recordEmojiUse", () => {
    test("creates a row on first use and increments rather than duplicating", async () => {
      await recordEmojiUse("🔥");
      await recordEmojiUse("🔥");
      await recordEmojiUse("🔥");

      const rows = await EmojiReactionUsage.findAll({ where: { emoji: "🔥" }, raw: true });
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].useCount)).toBe(3);
    });

    test("stores a multi-codepoint emoji intact", async () => {
      await recordEmojiUse("👨‍👩‍👧‍👦");

      const row = await EmojiReactionUsage.findByPk("👨‍👩‍👧‍👦", { raw: true });
      expect(row).not.toBeNull();
      expect(row.emoji).toBe("👨‍👩‍👧‍👦");
    });
  });

  describe("topReactionEmoji", () => {
    test("orders by usage, highest first", async () => {
      await recordEmojiUse("🔥");
      await recordEmojiUse("🔥");
      await recordEmojiUse("🎯");

      const top = await topReactionEmoji(2);
      expect(top).toEqual(["🔥", "🎯"]);
    });

    test("pads with the defaults so the bar is never short", async () => {
      await recordEmojiUse("🔥");

      const top = await topReactionEmoji(6);
      expect(top).toHaveLength(6);
      expect(top[0]).toBe("🔥");
      // Remaining slots come from the defaults, without repeating 🔥.
      expect(new Set(top).size).toBe(6);
    });

    test("returns the defaults when nothing has been used", async () => {
      const top = await topReactionEmoji(6);
      expect(top).toEqual(DEFAULT_REACTION_EMOJI);
    });
  });
});
