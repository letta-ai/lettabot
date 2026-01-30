/**
 * Directive parsing for assistant output.
 *
 * Directives are XML tags (e.g., <react>...</react>).
 */

export type AssistantAction =
  | { type: 'message'; content: string }
  | { type: 'react'; emoji: string; messageId?: string }
  | { type: 'send_file'; path: string; kind: 'image' | 'file' };

const KNOWN_TAGS = new Set(['react', 'send_image', 'send_file']);

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

function looksLikeMessageId(value: string): boolean {
  return /^[0-9][0-9.]*$/.test(value);
}
