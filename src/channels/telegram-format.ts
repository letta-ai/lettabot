/**
 * Telegram Text Formatting
 * 
 * Converts markdown to Telegram MarkdownV2 format using telegramify-markdown.
 * Supports: headers, bold, italic, code, links, blockquotes, lists, etc.
 */

/**
 * Convert markdown to Telegram MarkdownV2 format.
 * Handles proper escaping of special characters.
 */
export async function markdownToTelegramV2(markdown: string): Promise<string> {
  try {
    // Dynamic import to handle ESM module
    const telegramifyMarkdown = (await import('telegramify-markdown')).default;
    // Use 'keep' strategy to preserve blockquotes (>) and other unsupported elements
    return telegramifyMarkdown(markdown, 'keep');
  } catch (e) {
    console.error('[Telegram] Markdown conversion failed, using escape fallback:', e);
    // Fallback: escape special characters manually (loses formatting)
    return escapeMarkdownV2(markdown);
  }
}

/**
 * Escape MarkdownV2 special characters (fallback)
 */
function escapeMarkdownV2(text: string): string {
  const specialChars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
  let escaped = text;
  for (const char of specialChars) {
    escaped = escaped.replace(new RegExp(`\\${char}`, 'g'), `\\${char}`);
  }
  return escaped;
}

/**
 * Escape HTML special characters (for HTML parse mode fallback)
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Convert markdown to Telegram HTML format.
 * Fallback option - simpler but less feature-rich.
 * Supports: *bold*, _italic_, `code`, ~~strikethrough~~, ```code blocks```
 */
export function markdownToTelegramHtml(markdown: string): string {
  let text = markdown;
  
  // Process code blocks first (they shouldn't have other formatting inside)
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code>${escapeHtml(code.trim())}</code></pre>`;
  });
  
  // Inline code (escape content)
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    return `<code>${escapeHtml(code)}</code>`;
  });
  
  // Now escape remaining HTML (outside of code blocks)
  // Split by our tags to preserve them
  const parts = text.split(/(<\/?(?:pre|code|b|i|s|u|a)[^>]*>)/);
  text = parts.map((part, i) => {
    // Odd indices are our tags, keep them
    if (i % 2 === 1) return part;
    // Even indices are text, but skip if inside code
    return escapeHtml(part);
  }).join('');
  
  // Bold: **text** or *text*
  text = text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  text = text.replace(/\*([^*]+)\*/g, '<b>$1</b>');
  
  // Italic: __text__ or _text_
  text = text.replace(/__(.+?)__/g, '<i>$1</i>');
  text = text.replace(/_([^_]+)_/g, '<i>$1</i>');
  
  // Strikethrough: ~~text~~
  text = text.replace(/~~(.+?)~~/g, '<s>$1</s>');
  
  // Blockquotes: > text (convert to italic for now, HTML doesn't have blockquote in Telegram)
  text = text.replace(/^>\s*(.+)$/gm, '<blockquote>$1</blockquote>');
  
  return text;
}
