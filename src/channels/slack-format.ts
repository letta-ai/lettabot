/**
 * Slack Text Formatting
 *
 * Converts standard Markdown into Slack "mrkdwn" using slackify-markdown.
 * slackify-markdown is an optional dependency, so we use a dynamic import and
 * provide a conservative fallback if it is missing or fails at runtime.
 */

import { createLogger } from '../logger.js';

const log = createLogger('Slack');
type SlackifyFn = (markdown: string) => string;

let slackifyFn: SlackifyFn | null = null;
let slackifyLoadFailed = false;
let slackifyLoadPromise: Promise<SlackifyFn | null> | null = null;

async function loadSlackify(): Promise<SlackifyFn | null> {
  if (slackifyFn) return slackifyFn;
  if (slackifyLoadFailed) return null;
  if (slackifyLoadPromise) return slackifyLoadPromise;

  slackifyLoadPromise = (async () => {
    try {
      // Avoid a string-literal specifier so TypeScript doesn't require the module
      // to exist at build time when optional deps are omitted.
      const moduleId: string = 'slackify-markdown';
      const mod = await import(moduleId);
      const loaded =
        (mod as unknown as { slackifyMarkdown?: SlackifyFn }).slackifyMarkdown
        || (mod as unknown as { default?: SlackifyFn }).default;

      if (typeof loaded !== 'function') {
        throw new Error('slackify-markdown: missing slackifyMarkdown export');
      }

      slackifyFn = loaded;
      return loaded;
    } catch (e) {
      slackifyLoadFailed = true;
      const reason = e instanceof Error ? e.message : String(e);
      log.warn(`slackify-markdown unavailable; using fallback formatter (${reason})`);
      return null;
    }
  })();

  return slackifyLoadPromise;
}

/**
 * Convert Markdown to Slack mrkdwn.
 */
export async function markdownToSlackMrkdwn(markdown: string): Promise<string> {
  const converter = await loadSlackify();
  if (!converter) {
    return fallbackMarkdownToSlackMrkdwn(markdown);
  }

  try {
    return converter(markdown);
  } catch (e) {
    log.error('Markdown conversion failed, using fallback:', e);
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
