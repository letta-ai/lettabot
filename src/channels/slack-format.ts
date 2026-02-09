/**
 * Slack Text Formatting
 *
 * Converts standard Markdown into Slack "mrkdwn" using slackify-markdown.
 * slackify-markdown is an optional dependency, so we use a dynamic import and
 * provide a conservative fallback if it is missing or fails at runtime.
 */

/**
 * Convert Markdown to Slack mrkdwn.
 */
export async function markdownToSlackMrkdwn(markdown: string): Promise<string> {
  try {
    const mod = await import('slackify-markdown');
    const slackify =
      (mod as unknown as { slackifyMarkdown?: (s: string) => string }).slackifyMarkdown
      || (mod as unknown as { default?: (s: string) => string }).default;

    if (typeof slackify !== 'function') {
      throw new Error('slackify-markdown: missing slackifyMarkdown export');
    }

    return slackify(markdown);
  } catch (e) {
    console.error('[Slack] Markdown conversion failed, using fallback:', e);
    return fallbackMarkdownToSlackMrkdwn(markdown);
  }
}

/**
 * Heuristic conversion fallback that covers the most common Slack mrkdwn
 * differences. This is intentionally limited; if you need broader support,
 * install slackify-markdown.
 */
export function fallbackMarkdownToSlackMrkdwn(markdown: string): string {
  let text = markdown;

  // Slack ignores fenced code block language identifiers (```js -> ```).
  text = text.replace(/```[a-zA-Z0-9_-]+\n/g, '```\n');

  // Links: [label](url) -> <url|label>
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<$2|$1>');

  // Italic: *italic* -> _italic_ (avoid **bold**)
  text = text.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '_$1_');

  // Bold: **bold** / __bold__ -> *bold*
  text = text.replace(/\*\*([^*]+?)\*\*/g, '*$1*');
  text = text.replace(/__([^_]+?)__/g, '*$1*');

  // Strikethrough: ~~strike~~ -> ~strike~
  text = text.replace(/~~([^~]+?)~~/g, '~$1~');

  return text;
}
