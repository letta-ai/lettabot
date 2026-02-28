/**
 * Display formatting for tool calls, reasoning, and interactive questions.
 *
 * Pure functions extracted from LettaBot -- no class state needed.
 */

import type { StreamMsg } from './types.js';

// ---------------------------------------------------------------------------
// Tool call display config
// ---------------------------------------------------------------------------

/**
 * Pretty display config for known tools.
 * `header`: bold verb shown to the user (e.g., "Searching")
 * `argKeys`: ordered preference list of fields to extract from toolInput
 *            or tool_result JSON as the detail line
 * `format`: optional -- 'code' wraps the detail in backticks
 */
const TOOL_DISPLAY_MAP: Record<string, {
  header: string;
  argKeys: string[];
  format?: 'code';
  /** For 'code' format: if the first argKey value exceeds this length,
   *  fall back to the next argKey shown as plain text instead. */
  adaptiveCodeThreshold?: number;
  /** Dynamic header based on tool input. When provided, the return value
   *  replaces `header` entirely and no argKey detail is appended. */
  headerFn?: (input: Record<string, unknown>) => string;
}> = {
  web_search:          { header: 'Searching',      argKeys: ['query'] },
  fetch_webpage:       { header: 'Reading',         argKeys: ['url'] },
  Bash:                { header: 'Running',          argKeys: ['command', 'description'], format: 'code', adaptiveCodeThreshold: 80 },
  Read:                { header: 'Reading',          argKeys: ['file_path'] },
  Edit:                { header: 'Editing',          argKeys: ['file_path'] },
  Write:               { header: 'Writing',          argKeys: ['file_path'] },
  Glob:                { header: 'Finding files',    argKeys: ['pattern'] },
  Grep:                { header: 'Searching code',   argKeys: ['pattern'] },
  Task:                { header: 'Delegating',       argKeys: ['description'] },
  conversation_search: { header: 'Searching conversation history', argKeys: ['query'] },
  archival_memory_search: { header: 'Searching archival memory', argKeys: ['query'] },
  run_code:            { header: 'Running code',     argKeys: ['code'], format: 'code' },
  note:                { header: 'Taking note',      argKeys: ['title', 'content'] },
  manage_todo:         { header: 'Updating todos',   argKeys: [] },
  TodoWrite:           { header: 'Updating todos',   argKeys: [] },
  Skill:               {
    header: 'Loading skill',
    argKeys: ['skill'],
    headerFn: (input) => {
      const skill = input.skill as string | undefined;
      const command = (input.command as string | undefined) || (input.args as string | undefined);
      if (command === 'unload') return skill ? `Unloading ${skill}` : 'Unloading skill';
      if (command === 'refresh') return 'Refreshing skills';
      return skill ? `Loading ${skill}` : 'Loading skill';
    },
  },
};

// ---------------------------------------------------------------------------
// Tool detail extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract the first matching detail string from a tool call's input or
 * the subsequent tool_result content (fallback for empty toolInput).
 */
function extractToolDetail(
  argKeys: string[],
  streamMsg: StreamMsg,
  toolResult?: StreamMsg,
): string {
  if (argKeys.length === 0) return '';

  // 1. Try toolInput (primary -- when SDK provides args)
  const input = streamMsg.toolInput as Record<string, unknown> | undefined;
  if (input && typeof input === 'object') {
    for (const key of argKeys) {
      const val = input[key];
      if (typeof val === 'string' && val.length > 0) {
        return val.length > 120 ? val.slice(0, 117) + '...' : val;
      }
    }
  }

  // 2. Try tool_result content (fallback for empty toolInput)
  if (toolResult?.content) {
    try {
      const parsed = JSON.parse(toolResult.content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const key of argKeys) {
          const val = (parsed as Record<string, unknown>)[key];
          if (typeof val === 'string' && val.length > 0) {
            return val.length > 120 ? val.slice(0, 117) + '...' : val;
          }
        }
      }
    } catch { /* non-JSON result -- skip */ }
  }

  return '';
}

/**
 * Extract a brief parameter summary from a tool call's input.
 * Used only by the generic fallback display path.
 */
function abbreviateToolInput(streamMsg: StreamMsg): string {
  const input = streamMsg.toolInput as Record<string, unknown> | undefined;
  if (!input || typeof input !== 'object') return '';
  // Filter out undefined/null values (SDK yields {raw: undefined} for partial chunks)
  const entries = Object.entries(input).filter(([, v]) => v != null).slice(0, 2);
  return entries
    .map(([k, v]) => {
      let str: string;
      try {
        str = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
      } catch {
        str = String(v);
      }
      const truncated = str.length > 80 ? str.slice(0, 77) + '...' : str;
      return `${k}: ${truncated}`;
    })
    .join(', ');
}

/**
 * Fallback: extract input parameters from a tool_result's content.
 * Some tools echo their input in the result (e.g., web_search includes
 * `query`). Used only by the generic fallback display path.
 */
function extractInputFromToolResult(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';

    const inputKeys = ['query', 'input', 'prompt', 'url', 'search_query', 'text'];
    const parts: string[] = [];

    for (const key of inputKeys) {
      const val = (parsed as Record<string, unknown>)[key];
      if (typeof val === 'string' && val.length > 0) {
        const truncated = val.length > 80 ? val.slice(0, 77) + '...' : val;
        parts.push(`${key}: ${truncated}`);
        if (parts.length >= 2) break;
      }
    }

    return parts.join(', ');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Public display functions
// ---------------------------------------------------------------------------

/**
 * Format a tool call for channel display.
 *
 * Known tools get a pretty verb-based header (e.g., **Searching**).
 * Unknown tools fall back to **Tool**\n<name> (<args>).
 *
 * When toolInput is empty (SDK streaming limitation -- the CLI only
 * forwards the first chunk before args are accumulated), we fall back
 * to extracting the detail from the tool_result content.
 */
export function formatToolCallDisplay(streamMsg: StreamMsg, toolResult?: StreamMsg): string {
  const name = streamMsg.toolName || 'unknown';
  const display = TOOL_DISPLAY_MAP[name];

  if (display) {
    // --- Dynamic header path (e.g., Skill tool with load/unload/refresh modes) ---
    if (display.headerFn) {
      const input = (streamMsg.toolInput as Record<string, unknown> | undefined) ?? {};
      return `**${display.headerFn(input)}**`;
    }

    // --- Custom display path ---
    const detail = extractToolDetail(display.argKeys, streamMsg, toolResult);
    if (detail) {
      let formatted: string;
      if (display.format === 'code' && display.adaptiveCodeThreshold) {
        // Adaptive: short values get code format, long values fall back to
        // the next argKey as plain text (e.g., Bash shows `command` for short
        // commands, but the human-readable `description` for long ones).
        if (detail.length <= display.adaptiveCodeThreshold) {
          formatted = `\`${detail}\``;
        } else {
          const fallback = extractToolDetail(display.argKeys.slice(1), streamMsg, toolResult);
          formatted = fallback || detail.slice(0, display.adaptiveCodeThreshold) + '...';
        }
      } else {
        formatted = display.format === 'code' ? `\`${detail}\`` : detail;
      }
      return `**${display.header}**\n${formatted}`;
    }
    return `**${display.header}**`;
  }

  // --- Generic fallback for unknown tools ---
  let params = abbreviateToolInput(streamMsg);
  if (!params && toolResult?.content) {
    params = extractInputFromToolResult(toolResult.content);
  }
  return params ? `**Tool**\n${name} (${params})` : `**Tool**\n${name}`;
}

/**
 * Format reasoning text for channel display, respecting truncation config.
 * Returns { text, parseMode? } -- Telegram gets HTML with <blockquote> to
 * bypass telegramify-markdown (which adds unwanted spaces to blockquotes).
 * Signal falls back to italic (no blockquote support).
 * Discord/Slack use markdown blockquotes.
 */
export function formatReasoningDisplay(
  text: string,
  channelId?: string,
  reasoningMaxChars?: number,
): { text: string; parseMode?: string } {
  const maxChars = reasoningMaxChars ?? 0;
  // Trim leading whitespace from each line -- the API often includes leading
  // spaces in reasoning chunks that look wrong in channel output.
  const cleaned = text.split('\n').map(line => line.trimStart()).join('\n').trim();
  const truncated = maxChars > 0 && cleaned.length > maxChars
    ? cleaned.slice(0, maxChars) + '...'
    : cleaned;

  if (channelId === 'signal') {
    // Signal: no blockquote support, use italic
    return { text: `**Thinking**\n_${truncated}_` };
  }
  if (channelId === 'telegram' || channelId === 'telegram-mtproto') {
    // Telegram: use HTML blockquote to bypass telegramify-markdown spacing
    const escaped = truncated
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return {
      text: `<blockquote expandable><b>Thinking</b>\n${escaped}</blockquote>`,
      parseMode: 'HTML',
    };
  }
  // Discord, Slack, etc: markdown blockquote
  const lines = truncated.split('\n');
  const quoted = lines.map(line => `> ${line}`).join('\n');
  return { text: `> **Thinking**\n${quoted}` };
}

/**
 * Format AskUserQuestion options for channel display.
 */
export function formatQuestionsForChannel(questions: Array<{
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}>): string {
  const parts: string[] = [];
  for (const q of questions) {
    parts.push(`**${q.question}**`);
    parts.push('');
    for (let i = 0; i < q.options.length; i++) {
      parts.push(`${i + 1}. **${q.options[i].label}**`);
      parts.push(`   ${q.options[i].description}`);
    }
    if (q.multiSelect) {
      parts.push('');
      parts.push('_(You can select multiple options)_');
    }
  }
  parts.push('');
  parts.push('_Reply with your choice (number, name, or your own answer)._');
  return parts.join('\n');
}
