/**
 * Directive parsing for assistant output.
 *
 * Directives are single lines starting with a keyword and ":".
 */

export type AssistantAction =
  | { type: 'message'; content: string }
  | { type: 'react'; emoji: string; messageId?: string }
  | { type: 'send_file'; path: string; kind: 'image' | 'file' }
  | { type: 'edit'; messageId: string; text: string }
  | { type: 'fetch_history'; limit: number; before?: string };

export function parseAssistantActions(content: string): AssistantAction[] {
  const actions: AssistantAction[] = [];
  const messageLines: string[] = [];

  const flushMessage = () => {
    if (!messageLines.length) return;
    const text = messageLines.join('\n').trimEnd();
    messageLines.length = 0;
    if (text.trim()) {
      actions.push({ type: 'message', content: text });
    }
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    const stripped = line.trim();
    if (!stripped) {
      messageLines.push('');
      continue;
    }
    const directive = parseDirectiveLine(stripped);
    if (directive) {
      flushMessage();
      actions.push(directive);
    } else {
      messageLines.push(line);
    }
  }

  flushMessage();
  return actions;
}

function parseDirectiveLine(stripped: string): AssistantAction | null {
  const lowered = stripped.toLowerCase();
  if (lowered.startsWith('react')) {
    const parsed = parseReactDirective(stripped);
    return parsed ? parsed : null;
  }
  if (lowered.startsWith('send image')) {
    const arg = parseDirectiveArg(stripped, 'send image');
    return arg ? { type: 'send_file', path: arg, kind: 'image' } : null;
  }
  if (lowered.startsWith('send file')) {
    const arg = parseDirectiveArg(stripped, 'send file');
    return arg ? { type: 'send_file', path: arg, kind: 'file' } : null;
  }
  if (lowered.startsWith('edit')) {
    const parsed = parseEditDirective(stripped);
    return parsed ? parsed : null;
  }
  if (lowered.startsWith('fetch history')) {
    return parseFetchHistoryDirective(stripped);
  }
  return null;
}

function parseDirectiveArg(text: string, keyword: string): string | null {
  if (!text.toLowerCase().startsWith(keyword)) return null;
  let rest = text.slice(keyword.length).trimStart();
  if (!rest.startsWith(':')) return null;
  rest = rest.slice(1).trim();
  return rest || null;
}

function parseReactDirective(text: string): AssistantAction | null {
  const arg = parseDirectiveArg(text, 'react');
  if (!arg) return null;

  let messageId: string | undefined;
  let emoji = arg;
  const parts = arg.split(/\s+/);
  if (parts.length >= 2 && looksLikeMessageId(parts[0])) {
    messageId = parts[0];
    emoji = parts.slice(1).join(' ').trim();
  }
  if (!emoji) return null;
  return { type: 'react', emoji, messageId };
}

function parseEditDirective(text: string): AssistantAction | null {
  const arg = parseDirectiveArg(text, 'edit');
  if (!arg) return null;
  const parts = arg.split(/\s+/);
  if (parts.length < 2) return null;
  const messageId = parts[0];
  const body = arg.slice(messageId.length).trim();
  if (!body) return null;
  return { type: 'edit', messageId, text: body };
}

function parseFetchHistoryDirective(text: string): AssistantAction | null {
  const arg = parseDirectiveArg(text, 'fetch history');
  if (arg === null) return null;
  const parts = arg.split(/\s+/).filter(Boolean);
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
