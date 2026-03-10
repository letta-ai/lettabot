/**
 * Shared emoji alias table and resolver for channel adapters.
 *
 * All channels use the same alias-to-unicode mappings; only the
 * resolver behavior differs slightly (Slack needs reverse lookup).
 */

export const EMOJI_ALIASES: Record<string, string> = {
  eyes: '\u{1F440}',
  thumbsup: '\u{1F44D}',
  thumbs_up: '\u{1F44D}',
  '+1': '\u{1F44D}',
  heart: '\u2764\uFE0F',
  fire: '\u{1F525}',
  smile: '\u{1F604}',
  laughing: '\u{1F606}',
  tada: '\u{1F389}',
  clap: '\u{1F44F}',
  ok_hand: '\u{1F44C}',
  white_check_mark: '\u2705',
};

/**
 * Resolve an emoji alias (e.g. `:thumbsup:` or `thumbsup`) to its
 * unicode character. Returns the input unchanged if no alias matches.
 */
export function resolveEmoji(input: string): string {
  const match = input.match(/^:([^:]+):$/);
  const alias = match ? match[1] : null;
  if (alias && EMOJI_ALIASES[alias]) return EMOJI_ALIASES[alias];
  if (EMOJI_ALIASES[input]) return EMOJI_ALIASES[input];
  return input;
}
