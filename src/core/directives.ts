/**
 * Directive parsing for assistant output.
 *
 * Directives are XML tags (e.g., <react>...</react>).
 */

export type AssistantAction =
  | { type: 'message'; content: string }
  | { type: 'react'; emoji: string; messageId?: string }
  | { type: 'send_file'; path: string; kind: 'image' | 'file' }
  | { type: 'edit'; messageId: string; text: string }
  | { type: 'fetch_history'; limit: number; before?: string };

const KNOWN_TAGS = new Set(['react', 'send_image', 'send_file', 'edit', 'fetch_history']);

export class StreamingDirectiveParser {
  private buffer = '';

  ingest(chunk: string): { text: string; actions: AssistantAction[] } {
    return this.process(chunk, false);
  }

  flush(): { text: string; actions: AssistantAction[] } {
    return this.process('', true);
  }

  private process(chunk: string, flush: boolean): { text: string; actions: AssistantAction[] } {
    this.buffer += chunk;
    let output = '';
    const actions: AssistantAction[] = [];

    while (this.buffer.length > 0) {
      const start = this.buffer.indexOf('<');
      if (start === -1) {
        output += this.buffer;
        this.buffer = '';
        break;
      }

      if (start > 0) {
        output += this.buffer.slice(0, start);
        this.buffer = this.buffer.slice(start);
      }

      const tagMatch = this.buffer.match(/^<([a-z_]+)>/i);
      if (!tagMatch) {
        output += this.buffer[0];
        this.buffer = this.buffer.slice(1);
        continue;
      }

      const tagName = tagMatch[1].toLowerCase();
      if (!KNOWN_TAGS.has(tagName)) {
        output += this.buffer[0];
        this.buffer = this.buffer.slice(1);
        continue;
      }

      const openLen = tagMatch[0].length;
      const closeTag = `</${tagName}>`;
      const closeIdx = this.buffer.indexOf(closeTag, openLen);
      if (closeIdx === -1) {
        if (flush) {
          output += this.buffer;
          this.buffer = '';
        }
        break;
      }

      const inner = this.buffer.slice(openLen, closeIdx).trim();
      const action = parseDirectiveTag(tagName, inner);
      if (action) {
        actions.push(action);
      }
      this.buffer = this.buffer.slice(closeIdx + closeTag.length);
    }

    return { text: output, actions };
  }
}

export function parseDirectiveTag(tagName: string, content: string): AssistantAction | null {
  switch (tagName) {
    case 'react':
      return parseReactContent(content);
    case 'send_image':
      return content ? { type: 'send_file', path: content, kind: 'image' } : null;
    case 'send_file':
      return content ? { type: 'send_file', path: content, kind: 'file' } : null;
    case 'edit':
      return parseEditContent(content);
    case 'fetch_history':
      return parseFetchHistoryContent(content);
    default:
      return null;
  }
}

function parseReactContent(content: string): AssistantAction | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  let messageId: string | undefined;
  let emoji = trimmed;
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2 && looksLikeMessageId(parts[0])) {
    messageId = parts[0];
    emoji = parts.slice(1).join(' ').trim();
  }
  if (!emoji) return null;
  return { type: 'react', emoji, messageId };
}

function parseEditContent(content: string): AssistantAction | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return null;
  const messageId = parts[0];
  const body = trimmed.slice(messageId.length).trim();
  if (!body) return null;
  return { type: 'edit', messageId, text: body };
}

function parseFetchHistoryContent(content: string): AssistantAction | null {
  const parts = content.trim().split(/\s+/).filter(Boolean);
  let limit = 50;
  let before: string | undefined;

  if (parts.length > 0) {
    if (/^\d+$/.test(parts[0])) {
      limit = Number(parts[0]);
      parts.shift();
    }
    if (parts[0]?.toLowerCase() === 'before' && parts[1]) {
      before = parts[1];
    }
  }

  if (!Number.isFinite(limit) || limit <= 0) {
    limit = 50;
  }

  return { type: 'fetch_history', limit, before };
}

function looksLikeMessageId(value: string): boolean {
  return /^[0-9][0-9.]*$/.test(value);
}
