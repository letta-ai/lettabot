/**
 * XML Directive Parser
 *
 * Parses an <actions> block at the start of agent text responses.
 * Extends the existing <no-reply/> pattern to support richer actions
 * (reactions, file sends, etc.) without requiring tool calls.
 *
 * The <actions> block must appear at the start of the response:
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
}

export interface VoiceDirective {
  type: 'voice';
  text: string;
}

// Union type — extend with more directive types later
export type Directive = ReactDirective | SendFileDirective | VoiceDirective;

export interface ParseResult {
  cleanText: string;
  directives: Directive[];
}

/**
 * Match the <actions>...</actions> wrapper at the start of the response.
 * Captures the inner content of the block.
 */
const ACTIONS_BLOCK_REGEX = /^\s*<actions>([\s\S]*?)<\/actions>/;

/**
 * Match supported directive tags inside the actions block in source order.
 * - Self-closing: <react ... />, <send-file ... />
 * - Content-bearing: <voice>...</voice>
 */
const DIRECTIVE_TOKEN_REGEX = /<(react|send-file)\b([^>]*)\/>|<voice>([\s\S]*?)<\/voice>/g;

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
  const normalizedBlock = block.replace(/\\(['"])/g, '$1');

  // Reset regex state (global flag)
  DIRECTIVE_TOKEN_REGEX.lastIndex = 0;

  while ((match = DIRECTIVE_TOKEN_REGEX.exec(normalizedBlock)) !== null) {
    const [, tagName, attrString, voiceText] = match;

    if (voiceText !== undefined) {
      const text = voiceText.trim();
      if (text) {
        directives.push({ type: 'voice', text });
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
      });
    }
  }

  return directives;
}

/**
 * Parse XML directives from agent response text.
 *
 * Looks for an <actions>...</actions> block at the start of the response.
 * Returns the cleaned text (block stripped) and an array of parsed directives.
 * If no <actions> block is found, the text is returned unchanged.
 */
export function parseDirectives(text: string): ParseResult {
  const match = text.match(ACTIONS_BLOCK_REGEX);

  if (!match) {
    return { cleanText: text, directives: [] };
  }

  const actionsContent = match[1];
  const cleanText = text.slice(match[0].length).trim();
  const directives = parseChildDirectives(actionsContent);

  return { cleanText, directives };
}

/**
 * Strip a leading <actions>...</actions> block from text for streaming display.
 * Returns the text after the block, or the original text if no complete block found.
 */
export function stripActionsBlock(text: string): string {
  return text.replace(ACTIONS_BLOCK_REGEX, '').trim();
}
