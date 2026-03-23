/**
 * XML Directive Parser
 *
 * Parses <actions> blocks from agent text responses.
 * Extends the existing <no-reply/> pattern to support richer actions
 * (reactions, file sends, etc.) without requiring tool calls.
 *
 * <actions> blocks can appear anywhere in the response:
 *
 *   <actions>
 *     <react emoji="thumbsup" />
 *   </actions>
 *   Great idea!
 *
 *   → cleanText: "Great idea!"
 *   → directives: [{ type: 'react', emoji: 'thumbsup' }]
 */

export interface ReactDirective {
  type: 'react';
  emoji: string;
  messageId?: string;
}

export interface SendFileDirective {
  type: 'send-file';
  path: string;
  caption?: string;
  kind?: 'image' | 'file' | 'audio';
  cleanup?: boolean;
  channel?: string;
  chat?: string;
}

export interface SendMessageDirective {
  type: 'send-message';
  text: string;
  channel: string;
  chat: string;
}

export interface VoiceDirective {
  type: 'voice';
  text: string;
}

// Union type — extend with more directive types later
export type Directive = ReactDirective | SendFileDirective | SendMessageDirective | VoiceDirective;

export interface ParseResult {
  cleanText: string;
  directives: Directive[];
}

/**
 * Match complete <actions>...</actions> wrappers anywhere in the response.
 * Captures the inner content of each block.
 */
const ACTIONS_BLOCK_REGEX_SOURCE = '<actions>([\\s\\S]*?)<\\/actions>';

function createActionsBlockRegex(flags = 'g'): RegExp {
  return new RegExp(ACTIONS_BLOCK_REGEX_SOURCE, flags);
}

/**
 * Match supported directive tags inside the actions block in source order.
 * - Self-closing: <react ... />, <send-file ... />
 * - Content-bearing: <voice>...</voice>, <send-message ...>...</send-message>
 *
 * Groups:
 *   1: self-closing tag name (react|send-file)
 *   2: self-closing attribute string
 *   3: <voice> text content
 *   4: <send-message> attribute string
 *   5: <send-message> text content
 */
const DIRECTIVE_TOKEN_REGEX = /<(react|send-file)\b([^>]*)\/>|<voice>([\s\S]*?)<\/voice>|<send-message\b([^>]*)>([\s\S]*?)<\/send-message>/g;

/**
 * Parse a single attribute string like: emoji="eyes" message="123"
 */
function parseAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = attrRegex.exec(attrString)) !== null) {
    const [, name, doubleQuoted, singleQuoted] = match;
    attrs[name] = doubleQuoted ?? singleQuoted ?? '';
  }
  return attrs;
}

/**
 * Parse child directives from the inner content of an <actions> block.
 */
function parseChildDirectives(block: string): Directive[] {
  const directives: Directive[] = [];
  let match;
  const normalizedBlock = block.replace(/\\(['""])/g, '$1');

  // Reset regex state (global flag)
  DIRECTIVE_TOKEN_REGEX.lastIndex = 0;

  while ((match = DIRECTIVE_TOKEN_REGEX.exec(normalizedBlock)) !== null) {
    const [, tagName, attrString, voiceText, sendMsgAttrs, sendMsgText] = match;

    if (voiceText !== undefined) {
      const text = voiceText.trim();
      if (text) {
        directives.push({ type: 'voice', text });
      }
      continue;
    }

    if (sendMsgText !== undefined) {
      const text = sendMsgText.trim();
      const attrs = parseAttributes(sendMsgAttrs || '');
      if (text && attrs.channel && attrs.chat) {
        directives.push({ type: 'send-message', text, channel: attrs.channel, chat: attrs.chat });
      }
      continue;
    }

    if (tagName === 'react') {
      const attrs = parseAttributes(attrString || '');
      if (attrs.emoji) {
        directives.push({
          type: 'react',
          emoji: attrs.emoji,
          ...(attrs.message ? { messageId: attrs.message } : {}),
        });
      }
      continue;
    }

    if (tagName === 'send-file') {
      const attrs = parseAttributes(attrString || '');
      const path = attrs.path || attrs.file;
      if (!path) continue;
      const caption = attrs.caption || attrs.text;
      const kind = attrs.kind === 'image' || attrs.kind === 'file' || attrs.kind === 'audio'
        ? attrs.kind
        : undefined;
      const cleanup = attrs.cleanup === 'true';
      directives.push({
        type: 'send-file',
        path,
        ...(caption ? { caption } : {}),
        ...(kind ? { kind } : {}),
        ...(cleanup ? { cleanup } : {}),
        ...(attrs.channel ? { channel: attrs.channel } : {}),
        ...(attrs.chat ? { chat: attrs.chat } : {}),
      });
    }
  }

  return directives;
}

/**
 * Parse XML directives from agent response text.
 *
 * Looks for complete <actions>...</actions> blocks anywhere in the response.
 * Returns the cleaned text (all complete blocks stripped) and parsed directives.
 * If no complete block is found, the text is returned unchanged.
 */
export function parseDirectives(text: string): ParseResult {
  const blockRegex = createActionsBlockRegex();
  if (!blockRegex.test(text)) {
    return { cleanText: text, directives: [] };
  }

  const directives: Directive[] = [];
  const cleanText = text.replace(createActionsBlockRegex(), (_, actionsContent: string) => {
    directives.push(...parseChildDirectives(actionsContent));
    return '';
  }).trim();

  return { cleanText, directives };
}

/**
 * Returns true when text contains an opening <actions> tag with no matching
 * closing tag yet. Used during streaming to avoid flashing raw XML.
 */
export function hasUnclosedActionsBlock(text: string): boolean {
  const lastOpen = text.lastIndexOf('<actions>');
  if (lastOpen < 0) return false;
  const lastClose = text.lastIndexOf('</actions>');
  return lastOpen > lastClose;
}

/**
 * Returns true when the tail of the text contains a partial actions tag
 * (opening or closing) that has not streamed fully yet.
 */
export function hasIncompleteActionsTag(text: string): boolean {
  const lastLt = text.lastIndexOf('<');
  const lastGt = text.lastIndexOf('>');
  if (lastLt < 0 || lastLt <= lastGt) return false;
  const tail = text.slice(lastLt);
  return '<actions>'.startsWith(tail) || '</actions>'.startsWith(tail);
}

/**
 * Strip complete <actions>...</actions> blocks from text for streaming display.
 * Returns the text after stripping blocks, or the original text if none found.
 */
export function stripActionsBlock(text: string): string {
  return text.replace(createActionsBlockRegex(), '').trim();
}
