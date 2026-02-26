/**
 * Emoji alias resolution.
 *
 * Maps common text names (used by the LLM in <react> directives) to their
 * Unicode emoji characters. Shared between the directive executor and the
 * lettabot-react CLI.
 */

export const EMOJI_ALIAS_TO_UNICODE: Record<string, string> = {
  eyes: '👀',
  thumbsup: '👍',
  thumbs_up: '👍',
  '+1': '👍',
  thumbsdown: '👎',
  thumbs_down: '👎',
  '-1': '👎',
  heart: '❤️',
  fire: '🔥',
  smile: '😄',
  laughing: '😆',
  tada: '🎉',
  clap: '👏',
  ok_hand: '👌',
  wave: '👋',
  thinking: '🤔',
  pray: '🙏',
  rocket: '🚀',
  100: '💯',
  check: '✅',
  x: '❌',
  warning: '⚠️',
  star: '⭐',
  sparkles: '✨',
  bulb: '💡',
  memo: '📝',
};

const UNICODE_TO_ALIAS = new Map<string, string>(
  Object.entries(EMOJI_ALIAS_TO_UNICODE).map(([name, value]) => [value, name]),
);

/**
 * Strip optional colon wrappers: `:eyes:` → `eyes`
 */
function stripColons(input: string): string {
  const match = input.match(/^:([^:]+):$/);
  return match ? match[1] : input;
}

/**
 * Resolve an emoji string that may be a text alias, :alias:, or already Unicode.
 *
 * Returns `{ unicode, alias }` where:
 * - `unicode` is the resolved emoji character (or the original input if already Unicode)
 * - `alias` is the Slack-style name (without colons), or undefined if unknown
 */
export function resolveEmoji(input: string): { unicode: string; alias?: string } {
  const name = stripColons(input.trim());

  // Known alias → Unicode
  const fromAlias = EMOJI_ALIAS_TO_UNICODE[name];
  if (fromAlias) {
    return { unicode: fromAlias, alias: name };
  }

  // Already Unicode → look up alias
  const knownAlias = UNICODE_TO_ALIAS.get(input);
  return { unicode: input, alias: knownAlias };
}
