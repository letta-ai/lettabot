/**
 * LettaBot Core - Handles agent communication
 * 
 * Single agent, single conversation - chat continues across all channels.
 */

import { createAgent, createSession, resumeSession, imageFromFile, imageFromURL, type Session, type MessageContentItem, type SendMessage, type CanUseToolCallback } from '@letta-ai/letta-code-sdk';
import { mkdirSync, existsSync } from 'node:fs';
import { access, unlink, realpath, stat, constants } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { extname, resolve, join } from 'node:path';
import type { ChannelAdapter } from '../channels/types.js';
import type { BotConfig, InboundMessage, TriggerContext } from './types.js';
import type { AgentSession } from './interfaces.js';
import { Store } from './store.js';
import { updateAgentName, getPendingApprovals, rejectApproval, cancelRuns, cancelConversation, recoverOrphanedConversationApproval, getLatestRunError, getAgentModel, updateAgentModel } from '../tools/letta-api.js';
import { installSkillsToAgent, withAgentSkillsOnPath, getAgentSkillExecutableDirs, isVoiceMemoConfigured } from '../skills/loader.js';
import { formatMessageEnvelope, formatGroupBatchEnvelope, type SessionContextOptions } from './formatter.js';
import type { GroupBatcher } from './group-batcher.js';
import { loadMemoryBlocks } from './memory.js';
import { redactOutbound } from './redact.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { parseDirectives, stripActionsBlock, type Directive } from './directives.js';
import { resolveEmoji } from './emoji.js';
import { createManageTodoTool } from '../tools/todo.js';
import { syncTodosFromTool } from '../todo/store.js';


import { createLogger } from '../logger.js';

const log = createLogger('Bot');
/**
 * Detect if an error is a 409 CONFLICT from an orphaned approval.
 */
function isApprovalConflictError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('waiting for approval')) return true;
    if (msg.includes('conflict') && msg.includes('approval')) return true;
  }
  const statusError = error as { status?: number };
  if (statusError?.status === 409) return true;
  return false;
}

/**
 * Detect if an error indicates a missing conversation or agent.
 * Only these errors should trigger the "create new conversation" fallback.
 * Auth, network, and protocol errors should NOT be retried.
 */
function isConversationMissingError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('not found')) return true;
    if (msg.includes('conversation') && (msg.includes('missing') || msg.includes('does not exist'))) return true;
    if (msg.includes('agent') && msg.includes('not found')) return true;
  }
  const statusError = error as { status?: number };
  if (statusError?.status === 404) return true;
  return false;
}

/**
 * Map a structured API error into a clear, user-facing message.
 * The `error` object comes from the SDK's new SDKErrorMessage type.
 */
function formatApiErrorForUser(error: { message: string; stopReason: string; apiError?: Record<string, unknown> }): string {
  const msg = error.message.toLowerCase();
  const apiError = error.apiError || {};
  const apiMsg = (typeof apiError.message === 'string' ? apiError.message : '').toLowerCase();
  const reasons: string[] = Array.isArray(apiError.reasons) ? apiError.reasons : [];

  // Billing / credits exhausted
  if (msg.includes('out of credits') || apiMsg.includes('out of credits')) {
    return '(Out of credits for hosted inference. Add credits or enable auto-recharge at app.letta.com/settings/organization/usage.)';
  }

  // Rate limiting / usage exceeded (429)
  if (msg.includes('rate limit') || msg.includes('429') || msg.includes('usage limit')
    || apiMsg.includes('rate limit') || apiMsg.includes('usage limit')) {
    if (reasons.includes('premium-usage-exceeded') || msg.includes('hosted model usage limit')) {
      return '(Rate limited -- your Letta Cloud usage limit has been exceeded. Check your plan at app.letta.com.)';
    }
    const reasonStr = reasons.length > 0 ? `: ${reasons.join(', ')}` : '';
    return `(Rate limited${reasonStr}. Try again in a moment.)`;
  }

  // 409 CONFLICT (concurrent request on same conversation)
  if (msg.includes('conflict') || msg.includes('409') || msg.includes('another request is currently being processed')) {
    return '(Another request is still processing on this conversation. Wait a moment and try again.)';
  }

  // Authentication
  if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('forbidden')) {
    return '(Authentication failed -- check your API key in lettabot.yaml.)';
  }

  // Agent/conversation not found
  if (msg.includes('not found') || msg.includes('404')) {
    return '(Agent or conversation not found -- the configured agent may have been deleted. Try re-onboarding.)';
  }

  // Server errors
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('internal server error')) {
    return '(Letta API server error -- try again in a moment.)';
  }

  // Fallback: use the actual error message (truncated for safety)
  const detail = error.message.length > 200 ? error.message.slice(0, 200) + '...' : error.message;
  const trimmed = detail.replace(/[.\s]+$/, '');
  return `(Agent error: ${trimmed}. Try sending your message again.)`;
}

const SUPPORTED_IMAGE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
]);

const IMAGE_FILE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff',
]);

const AUDIO_FILE_EXTENSIONS = new Set([
  '.ogg', '.opus', '.mp3', '.m4a', '.wav', '.aac', '.flac',
]);

/** Infer whether a file is an image, audio, or generic file based on extension. */
export function inferFileKind(filePath: string): 'image' | 'file' | 'audio' {
  const ext = extname(filePath).toLowerCase();
  if (IMAGE_FILE_EXTENSIONS.has(ext)) return 'image';
  if (AUDIO_FILE_EXTENSIONS.has(ext)) return 'audio';
  return 'file';
}

/**
 * Check whether a resolved file path is inside the allowed directory.
 * Prevents path traversal attacks in the send-file directive.
 *
 * Uses realpath() for both the file and directory to follow symlinks,
 * preventing symlink-based escapes (e.g., data/evil -> /etc/passwd).
 * Falls back to textual resolve() when paths don't exist on disk.
 */
export async function isPathAllowed(filePath: string, allowedDir: string): Promise<boolean> {
  // Resolve the allowed directory -- use realpath if it exists, resolve() otherwise
  let canonicalDir: string;
  try {
    canonicalDir = await realpath(allowedDir);
  } catch {
    canonicalDir = resolve(allowedDir);
  }

  // Resolve the file -- use realpath if it exists, resolve() otherwise
  let canonicalFile: string;
  try {
    canonicalFile = await realpath(filePath);
  } catch {
    canonicalFile = resolve(filePath);
  }

  return canonicalFile === canonicalDir || canonicalFile.startsWith(canonicalDir + '/');
}

async function buildMultimodalMessage(
  formattedText: string,
  msg: InboundMessage,
): Promise<SendMessage> {
  if (process.env.INLINE_IMAGES === 'false') {
    return formattedText;
  }

  const imageAttachments = (msg.attachments ?? []).filter(
    (a) => a.kind === 'image'
      && (a.localPath || a.url)
      && (!a.mimeType || SUPPORTED_IMAGE_MIMES.has(a.mimeType))
  );

  if (imageAttachments.length === 0) {
    return formattedText;
  }

  const content: MessageContentItem[] = [
    { type: 'text', text: formattedText },
  ];

  for (const attachment of imageAttachments) {
    try {
      if (attachment.localPath) {
        content.push(imageFromFile(attachment.localPath));
      } else if (attachment.url) {
        content.push(await imageFromURL(attachment.url));
      }
    } catch (err) {
      log.warn(`Failed to load image ${attachment.name || 'unknown'}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (content.length > 1) {
    log.info(`Sending ${content.length - 1} inline image(s) to LLM`);
  }

  return content.length > 1 ? content : formattedText;
}

// ---------------------------------------------------------------------------
// Stream message type with toolCallId/uuid for dedup
// ---------------------------------------------------------------------------
export interface StreamMsg {
  type: string;
  content?: string;
  toolCallId?: string;
  toolName?: string;
  uuid?: string;
  isError?: boolean;
  result?: string;
  success?: boolean;
  error?: string;
  [key: string]: unknown;
}

export function isResponseDeliverySuppressed(msg: Pick<InboundMessage, 'isListeningMode'>): boolean {
  return msg.isListeningMode === true;
}

/**
 * Pure function: resolve the conversation key for a channel message.
 * Returns `${channel}:${chatId}` in per-chat mode.
 * Returns the channel id in per-channel mode or when the channel is in overrides.
 * Returns 'shared' otherwise.
 */
export function resolveConversationKey(
  channel: string,
  conversationMode: string | undefined,
  conversationOverrides: Set<string>,
  chatId?: string,
): string {
  const normalized = channel.toLowerCase();
  if (conversationMode === 'per-chat' && chatId) return `${normalized}:${chatId}`;
  if (conversationMode === 'per-channel') return normalized;
  if (conversationOverrides.has(normalized)) return normalized;
  return 'shared';
}

/**
 * Pure function: resolve the conversation key for heartbeat/sendToAgent.
 * In per-chat mode, uses the full channel:chatId of the last-active target.
 * In per-channel mode, respects heartbeatConversation setting.
 * In shared mode with overrides, respects override channels when using last-active.
 */
export function resolveHeartbeatConversationKey(
  conversationMode: string | undefined,
  heartbeatConversation: string | undefined,
  conversationOverrides: Set<string>,
  lastActiveChannel?: string,
  lastActiveChatId?: string,
): string {
  const hb = heartbeatConversation || 'last-active';

  if (conversationMode === 'per-chat') {
    if (hb === 'dedicated') return 'heartbeat';
    if (hb === 'last-active' && lastActiveChannel && lastActiveChatId) {
      return `${lastActiveChannel.toLowerCase()}:${lastActiveChatId}`;
    }
    // Fall back to shared if no last-active target
    return 'shared';
  }

  if (conversationMode === 'per-channel') {
    if (hb === 'dedicated') return 'heartbeat';
    if (hb === 'last-active') return lastActiveChannel ?? 'shared';
    return hb;
  }

  // shared mode — if last-active and overrides exist, respect the override channel
  if (hb === 'last-active' && conversationOverrides.size > 0 && lastActiveChannel) {
    return resolveConversationKey(lastActiveChannel, conversationMode, conversationOverrides);
  }

  return 'shared';
}

export class LettaBot implements AgentSession {
  private store: Store;
  private config: BotConfig;
  private channels: Map<string, ChannelAdapter> = new Map();
  private messageQueue: Array<{ msg: InboundMessage; adapter: ChannelAdapter }> = [];
  private lastUserMessageTime: Date | null = null;
  
  // Callback to trigger heartbeat (set by main.ts)
  public onTriggerHeartbeat?: () => Promise<void>;
  private groupBatcher?: GroupBatcher;
  private groupIntervals: Map<string, number> = new Map();
  private instantGroupIds: Set<string> = new Set();
  private listeningGroupIds: Set<string> = new Set();
  private processing = false; // Global lock for shared mode
  private processingKeys: Set<string> = new Set(); // Per-key locks for per-channel mode
  private cancelledKeys: Set<string> = new Set(); // Tracks keys where /cancel was issued

  // AskUserQuestion support: resolves when the next user message arrives.
  // In per-chat mode, keyed by convKey so each chat resolves independently.
  // In shared mode, a single entry keyed by 'shared' provides legacy behavior.
  private pendingQuestionResolvers: Map<string, (text: string) => void> = new Map();

  // Persistent sessions: reuse CLI subprocesses across messages.
  // In shared mode, only the "shared" key is used. In per-channel mode, each
  // channel (and optionally heartbeat) gets its own subprocess. In per-chat
  // mode, each unique channel:chatId gets its own subprocess (LRU-evicted).
  private sessions: Map<string, Session> = new Map();
  private sessionLastUsed: Map<string, number> = new Map(); // LRU tracking for per-chat mode
  // Coalesces concurrent ensureSessionForKey calls for the same key so the
  // second caller waits for the first instead of creating a duplicate session.
  // generation prevents stale in-flight creations from being reused after reset.
  private sessionCreationLocks: Map<string, { promise: Promise<Session>; generation: number }> = new Map();
  private sessionGenerations: Map<string, number> = new Map();
  private currentCanUseTool: CanUseToolCallback | undefined;
  private conversationOverrides: Set<string> = new Set();
  // Stable callback wrapper so the Session options never change, but we can
  // swap out the per-message handler before each send().
  private readonly sessionCanUseTool: CanUseToolCallback = async (toolName, toolInput) => {
    if (this.currentCanUseTool) {
      return this.currentCanUseTool(toolName, toolInput);
    }
    return { behavior: 'allow' as const };
  };
  
  constructor(config: BotConfig) {
    this.config = config;
    mkdirSync(config.workingDir, { recursive: true });
    this.store = new Store('lettabot-agent.json', config.agentName);
    if (config.conversationOverrides?.length) {
      this.conversationOverrides = new Set(config.conversationOverrides.map((ch) => ch.toLowerCase()));
    }
    log.info(`LettaBot initialized. Agent ID: ${this.store.agentId || '(new)'}`);
  }

  // =========================================================================
  // Response prefix (for multi-agent group chat identification)
  // =========================================================================

  /**
   * Prepend configured displayName prefix to outbound agent responses.
   * Returns text unchanged if no prefix is configured.
   */
  private prefixResponse(text: string): string {
    if (!this.config.displayName) return text;
    return `${this.config.displayName}: ${text}`;
  }

  // ---- Tool call display ----

  /**
   * Pretty display config for known tools.
   * `header`: bold verb shown to the user (e.g., "Searching")
   * `argKeys`: ordered preference list of fields to extract from toolInput
   *            or tool_result JSON as the detail line
   * `format`: optional -- 'code' wraps the detail in backticks
   */
  private static readonly TOOL_DISPLAY_MAP: Record<string, {
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
  private formatToolCallDisplay(streamMsg: StreamMsg, toolResult?: StreamMsg): string {
    const name = streamMsg.toolName || 'unknown';
    const display = LettaBot.TOOL_DISPLAY_MAP[name];

    if (display) {
      // --- Dynamic header path (e.g., Skill tool with load/unload/refresh modes) ---
      if (display.headerFn) {
        const input = (streamMsg.toolInput as Record<string, unknown> | undefined) ?? {};
        return `**${display.headerFn(input)}**`;
      }

      // --- Custom display path ---
      const detail = this.extractToolDetail(display.argKeys, streamMsg, toolResult);
      if (detail) {
        let formatted: string;
        if (display.format === 'code' && display.adaptiveCodeThreshold) {
          // Adaptive: short values get code format, long values fall back to
          // the next argKey as plain text (e.g., Bash shows `command` for short
          // commands, but the human-readable `description` for long ones).
          if (detail.length <= display.adaptiveCodeThreshold) {
            formatted = `\`${detail}\``;
          } else {
            const fallback = this.extractToolDetail(display.argKeys.slice(1), streamMsg, toolResult);
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
    let params = this.abbreviateToolInput(streamMsg);
    if (!params && toolResult?.content) {
      params = this.extractInputFromToolResult(toolResult.content);
    }
    return params ? `**Tool**\n${name} (${params})` : `**Tool**\n${name}`;
  }

  /**
   * Extract the first matching detail string from a tool call's input or
   * the subsequent tool_result content (fallback for empty toolInput).
   */
  private extractToolDetail(
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
  private abbreviateToolInput(streamMsg: StreamMsg): string {
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
  private extractInputFromToolResult(content: string): string {
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

  /**
   * Format reasoning text for channel display, respecting truncation config.
   * Returns { text, parseMode? } -- Telegram gets HTML with <blockquote> to
   * bypass telegramify-markdown (which adds unwanted spaces to blockquotes).
   * Signal falls back to italic (no blockquote support).
   * Discord/Slack use markdown blockquotes.
   */
  private formatReasoningDisplay(text: string, channelId?: string): { text: string; parseMode?: string } {
    const maxChars = this.config.display?.reasoningMaxChars ?? 0;
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

  // =========================================================================
  // Session options (shared by processMessage and sendToAgent)
  // =========================================================================

  private getTodoAgentKey(): string {
    return this.store.agentId || this.config.agentName || 'LettaBot';
  }

  private syncTodoToolCall(streamMsg: StreamMsg): void {
    if (streamMsg.type !== 'tool_call') return;

    const normalizedToolName = (streamMsg.toolName || '').toLowerCase();
    const isBuiltInTodoTool = normalizedToolName === 'todowrite'
      || normalizedToolName === 'todo_write'
      || normalizedToolName === 'writetodos'
      || normalizedToolName === 'write_todos';
    if (!isBuiltInTodoTool) return;

    const input = (streamMsg.toolInput && typeof streamMsg.toolInput === 'object')
      ? streamMsg.toolInput as Record<string, unknown>
      : null;
    if (!input || !Array.isArray(input.todos)) return;

    const incoming: Array<{
      content?: string;
      description?: string;
      status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    }> = [];
    for (const item of input.todos) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const statusRaw = typeof obj.status === 'string' ? obj.status : '';
      if (!['pending', 'in_progress', 'completed', 'cancelled'].includes(statusRaw)) continue;
      incoming.push({
        content: typeof obj.content === 'string' ? obj.content : undefined,
        description: typeof obj.description === 'string' ? obj.description : undefined,
        status: statusRaw as 'pending' | 'in_progress' | 'completed' | 'cancelled',
      });
    }
    if (incoming.length === 0) return;

    try {
      const summary = syncTodosFromTool(this.getTodoAgentKey(), incoming);
      if (summary.added > 0 || summary.updated > 0) {
        log.info(`Synced ${summary.totalIncoming} todo(s) from ${streamMsg.toolName} into heartbeat store (added=${summary.added}, updated=${summary.updated})`);
      }
    } catch (err) {
      log.warn('Failed to sync TodoWrite todos:', err instanceof Error ? err.message : err);
    }
  }

  private getSessionTimeoutMs(): number {
    const envTimeoutMs = Number(process.env.LETTA_SESSION_TIMEOUT_MS);
    if (Number.isFinite(envTimeoutMs) && envTimeoutMs > 0) {
      return envTimeoutMs;
    }
    return 60000;
  }

  private async withSessionTimeout<T>(
    promise: Promise<T>,
    label: string,
  ): Promise<T> {
    const timeoutMs = this.getSessionTimeoutMs();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private baseSessionOptions(canUseTool?: CanUseToolCallback) {
    return {
      permissionMode: 'bypassPermissions' as const,
      allowedTools: this.config.allowedTools,
      disallowedTools: [
        // Block built-in TodoWrite -- it requires interactive approval (fails
        // silently during heartbeats) and writes to the CLI's own store rather
        // than lettabot's persistent heartbeat store.  The agent should use the
        // custom manage_todo tool instead.
        'TodoWrite',
        ...(this.config.disallowedTools || []),
      ],
      cwd: this.config.workingDir,
      tools: [createManageTodoTool(this.getTodoAgentKey())],
      // Memory filesystem (context repository): true -> --memfs, false -> --no-memfs, undefined -> leave unchanged
      ...(this.config.memfs !== undefined ? { memfs: this.config.memfs } : {}),
      // In bypassPermissions mode, canUseTool is only called for interactive
      // tools (AskUserQuestion, ExitPlanMode). When no callback is provided
      // (background triggers), the SDK auto-denies interactive tools.
      ...(canUseTool ? { canUseTool } : {}),
    };
  }

  // =========================================================================
  // AskUserQuestion formatting
  // =========================================================================

  /**
   * Format AskUserQuestion questions as a single channel message.
   * Displays each question with numbered options for the user to choose from.
   */
  private formatQuestionsForChannel(questions: Array<{
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

  // =========================================================================
  // Session lifecycle helpers
  // =========================================================================

  /**
   * Execute parsed directives (reactions, etc.) via the channel adapter.
   * Returns true if any directive was successfully executed.
   */
  private async executeDirectives(
    directives: Directive[],
    adapter: ChannelAdapter,
    chatId: string,
    fallbackMessageId?: string,
    threadId?: string,
  ): Promise<boolean> {
    let acted = false;
    for (const directive of directives) {
      if (directive.type === 'react') {
        const targetId = directive.messageId || fallbackMessageId;
        if (!adapter.addReaction) {
          log.warn(`Directive react skipped: ${adapter.name} does not support addReaction`);
          continue;
        }
        if (targetId) {
          // Resolve text aliases (thumbsup, eyes, etc.) to Unicode characters.
          // The LLM typically outputs names; channel APIs need actual emoji.
          const resolved = resolveEmoji(directive.emoji);
          try {
            await adapter.addReaction(chatId, targetId, resolved.unicode);
            acted = true;
            log.info(`Directive: reacted with ${resolved.unicode} (${directive.emoji})`);
          } catch (err) {
            log.warn('Directive react failed:', err instanceof Error ? err.message : err);
          }
        }
        continue;
      }

      if (directive.type === 'send-file') {
        if (typeof adapter.sendFile !== 'function') {
          log.warn(`Directive send-file skipped: ${adapter.name} does not support sendFile`);
          continue;
        }

        // Path sandboxing: resolve both config and directive paths relative to workingDir.
        // This keeps behavior consistent when process.cwd differs from agent workingDir.
        const allowedDirConfig = this.config.sendFileDir || join('data', 'outbound');
        const allowedDir = resolve(this.config.workingDir, allowedDirConfig);
        const resolvedPath = resolve(this.config.workingDir, directive.path);
        if (!await isPathAllowed(resolvedPath, allowedDir)) {
          log.warn(`Directive send-file blocked: ${directive.path} is outside allowed directory ${allowedDir}`);
          continue;
        }

        // Async file existence + readability check
        try {
          await access(resolvedPath, constants.R_OK);
        } catch {
          log.warn(`Directive send-file skipped: file not found or not readable at ${directive.path}`);
          continue;
        }

        // File size guard (default: 50MB)
        const maxSize = this.config.sendFileMaxSize ?? 50 * 1024 * 1024;
        try {
          const fileStat = await stat(resolvedPath);
          if (fileStat.size > maxSize) {
            log.warn(`Directive send-file blocked: ${directive.path} is ${fileStat.size} bytes (max: ${maxSize})`);
            continue;
          }
        } catch {
          log.warn(`Directive send-file skipped: could not stat ${directive.path}`);
          continue;
        }

        try {
          await adapter.sendFile({
            chatId,
            filePath: resolvedPath,
            caption: directive.caption,
            kind: directive.kind ?? inferFileKind(resolvedPath),
            threadId,
          });
          acted = true;
          log.info(`Directive: sent file ${resolvedPath}`);

          // Optional cleanup: delete file after successful send.
          // Only honored when sendFileCleanup is enabled in config (defense-in-depth).
          if (directive.cleanup && this.config.sendFileCleanup) {
            try {
              await unlink(resolvedPath);
              log.warn(`Directive: cleaned up ${resolvedPath}`);
            } catch (cleanupErr) {
              log.warn('Directive send-file cleanup failed:', cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
            }
          }
        } catch (err) {
          log.warn('Directive send-file failed:', err instanceof Error ? err.message : err);
        }
      }

      if (directive.type === 'voice') {
        if (!isVoiceMemoConfigured()) {
          log.warn('Directive voice skipped: no TTS credentials configured');
          continue;
        }
        if (typeof adapter.sendFile !== 'function') {
          log.warn(`Directive voice skipped: ${adapter.name} does not support sendFile`);
          continue;
        }

        // Find lettabot-tts in agent's skill dirs
        const agentId = this.store.agentId;
        const skillDirs = agentId ? getAgentSkillExecutableDirs(agentId) : [];
        const ttsPath = skillDirs
          .map(dir => join(dir, 'lettabot-tts'))
          .find(p => existsSync(p));

        if (!ttsPath) {
          log.warn('Directive voice skipped: lettabot-tts not found in skill dirs');
          continue;
        }

        try {
          const outputPath = await new Promise<string>((resolve, reject) => {
            execFile(ttsPath, [directive.text], {
              cwd: this.config.workingDir,
              env: { ...process.env, LETTABOT_WORKING_DIR: this.config.workingDir },
              timeout: 30_000,
            }, (err, stdout, stderr) => {
              if (err) {
                reject(new Error(stderr?.trim() || err.message));
              } else {
                resolve(stdout.trim());
              }
            });
          });

          await adapter.sendFile({
            chatId,
            filePath: outputPath,
            kind: 'audio',
            threadId,
          });
          acted = true;
          log.info(`Directive: sent voice memo (${directive.text.length} chars)`);

          // Clean up generated file
          try { await unlink(outputPath); } catch {}
        } catch (err) {
          log.warn('Directive voice failed:', err instanceof Error ? err.message : err);
        }
      }
    }
    return acted;
  }

  // =========================================================================
  // Conversation key resolution
  // =========================================================================

  /**
   * Resolve the conversation key for a channel message.
   * Returns 'shared' in shared mode (unless channel is in perChannel overrides).
   * Returns channel id in per-channel mode or for override channels.
   */
  private resolveConversationKey(channel: string, chatId?: string): string {
    return resolveConversationKey(channel, this.config.conversationMode, this.conversationOverrides, chatId);
  }

  /**
   * Resolve the conversation key for heartbeat/sendToAgent.
   * Respects perChannel overrides when using last-active in shared mode.
   */
  private resolveHeartbeatConversationKey(): string {
    const target = this.store.lastMessageTarget;
    return resolveHeartbeatConversationKey(
      this.config.conversationMode,
      this.config.heartbeatConversation,
      this.conversationOverrides,
      target?.channel,
      target?.chatId,
    );
  }

  // =========================================================================
  // Session lifecycle (per-key)
  // =========================================================================

  /**
   * Return the persistent session for the given conversation key,
   * creating and initializing it if needed.
   *
   * After initialization, calls bootstrapState() to detect pending approvals.
   * If an orphaned approval is found, recovers proactively before returning
   * the session -- preventing the first send() from hitting a 409 CONFLICT.
   */
  private async ensureSessionForKey(key: string, bootstrapRetried = false): Promise<Session> {
    const generation = this.sessionGenerations.get(key) ?? 0;

    // Fast path: session already exists
    const existing = this.sessions.get(key);
    if (existing) {
      this.sessionLastUsed.set(key, Date.now());
      return existing;
    }

    // Coalesce concurrent callers: if another call is already creating this
    // key (e.g. warmSession running while first message arrives), wait for
    // it instead of creating a duplicate session.
    const pending = this.sessionCreationLocks.get(key);
    if (pending && pending.generation === generation) return pending.promise;

    const promise = this._createSessionForKey(key, bootstrapRetried, generation);
    this.sessionCreationLocks.set(key, { promise, generation });
    try {
      return await promise;
    } finally {
      const current = this.sessionCreationLocks.get(key);
      if (current?.promise === promise) {
        this.sessionCreationLocks.delete(key);
      }
    }
  }

  /** Internal session creation -- called via ensureSessionForKey's lock. */
  private async _createSessionForKey(
    key: string,
    bootstrapRetried: boolean,
    generation: number,
  ): Promise<Session> {
    // Session was invalidated while this creation path was queued.
    if ((this.sessionGenerations.get(key) ?? 0) !== generation) {
      return this.ensureSessionForKey(key, bootstrapRetried);
    }

    // Re-read the store file from disk so we pick up agent/conversation ID
    // changes made by other processes (e.g. after a restart or container deploy).
    // This costs one synchronous disk read per incoming message, which is fine
    // at chat-bot throughput. If this ever becomes a bottleneck, throttle to
    // refresh at most once per second.
    this.store.refresh();

    const opts = this.baseSessionOptions(this.sessionCanUseTool);
    let session: Session;
    let sessionAgentId: string | undefined;

    // In per-channel mode, look up per-key conversation ID.
    // In shared mode (key === "shared"), use the legacy single conversationId.
    const convId = key === 'shared'
      ? this.store.conversationId
      : this.store.getConversationId(key);

    if (convId) {
      process.env.LETTA_AGENT_ID = this.store.agentId || undefined;
      if (this.store.agentId) {
        installSkillsToAgent(this.store.agentId, this.config.skills);
        sessionAgentId = this.store.agentId;
      }
      session = resumeSession(convId, opts);
    } else if (this.store.agentId) {
      process.env.LETTA_AGENT_ID = this.store.agentId;
      installSkillsToAgent(this.store.agentId, this.config.skills);
      sessionAgentId = this.store.agentId;
      session = createSession(this.store.agentId, opts);
    } else {
      // Create new agent -- persist immediately so we don't orphan it on later failures
      log.info('Creating new agent');
      const newAgentId = await createAgent({
        systemPrompt: SYSTEM_PROMPT,
        memory: loadMemoryBlocks(this.config.agentName),
        tags: ['origin:lettabot'],
        ...(this.config.memfs !== undefined ? { memfs: this.config.memfs } : {}),
      });
      const currentBaseUrl = process.env.LETTA_BASE_URL || 'https://api.letta.com';
      this.store.setAgent(newAgentId, currentBaseUrl);
      log.info('Saved new agent ID:', newAgentId);

      if (this.config.agentName) {
        updateAgentName(newAgentId, this.config.agentName).catch(() => {});
      }
      installSkillsToAgent(newAgentId, this.config.skills);
      sessionAgentId = newAgentId;

      session = createSession(newAgentId, opts);
    }

    // Initialize eagerly so the subprocess is ready before the first send()
    log.info(`Initializing session subprocess (key=${key})...`);
    try {
      if (sessionAgentId) {
        await withAgentSkillsOnPath(
          sessionAgentId,
          () => this.withSessionTimeout(session.initialize(), `Session initialize (key=${key})`),
        );
      } else {
        await this.withSessionTimeout(session.initialize(), `Session initialize (key=${key})`);
      }
      log.info(`Session subprocess ready (key=${key})`);
    } catch (error) {
      // Close immediately so failed initialization cannot leak a subprocess.
      session.close();
      throw error;
    }

    // reset/invalidate can happen while initialize() is in-flight.
    if ((this.sessionGenerations.get(key) ?? 0) !== generation) {
      log.info(`Discarding stale initialized session (key=${key})`);
      session.close();
      return this.ensureSessionForKey(key, bootstrapRetried);
    }

    // Proactive approval detection via bootstrapState().
    // Single CLI round-trip that returns hasPendingApproval flag alongside
    // session metadata. If an orphaned approval is stuck, recover now so the
    // first send() doesn't hit a 409 CONFLICT.
    if (!bootstrapRetried && this.store.agentId) {
      try {
        const bootstrap = await this.withSessionTimeout(
          session.bootstrapState(),
          `Session bootstrapState (key=${key})`,
        );
        if (bootstrap.hasPendingApproval) {
          const convId = bootstrap.conversationId || session.conversationId;
          log.warn(`Pending approval detected at session startup (key=${key}, conv=${convId}), recovering...`);
          session.close();
          if (convId) {
            const result = await recoverOrphanedConversationApproval(
              this.store.agentId,
              convId,
              true, /* deepScan */
            );
            if (result.recovered) {
              log.info(`Proactive approval recovery succeeded: ${result.details}`);
            } else {
              log.warn(`Proactive approval recovery did not find resolvable approvals: ${result.details}`);
            }
          }
          // Recreate session after recovery (conversation state changed).
          // Call _createSessionForKey directly (not ensureSessionForKey) since
          // we're already inside the creation lock for this key.
          return this._createSessionForKey(key, true, generation);
        }
      } catch (err) {
        // bootstrapState failure is non-fatal -- the session is still usable.
        // The reactive 409 handler in runSession() will catch stuck approvals.
        log.warn(`bootstrapState check failed (key=${key}), continuing:`, err instanceof Error ? err.message : err);
      }
    }

    if ((this.sessionGenerations.get(key) ?? 0) !== generation) {
      log.info(`Discarding stale session after bootstrapState (key=${key})`);
      session.close();
      return this.ensureSessionForKey(key, bootstrapRetried);
    }

    // LRU eviction: in per-chat mode, limit concurrent sessions to avoid
    // unbounded subprocess growth. Evicted sessions can be cheaply recreated
    // via resumeSession() since conversation IDs are persisted in the store.
    const maxSessions = this.config.maxSessions ?? 10;
    if (this.config.conversationMode === 'per-chat' && this.sessions.size >= maxSessions) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, ts] of this.sessionLastUsed) {
        if (k === key) continue;
        if (!this.sessions.has(k)) continue;
        // Never evict an active/in-flight key (can close a live stream).
        if (this.processingKeys.has(k) || this.sessionCreationLocks.has(k)) continue;
        if (ts < oldestTime) {
          oldestKey = k;
          oldestTime = ts;
        }
      }
      if (oldestKey) {
        log.info(`LRU session eviction: closing session for key="${oldestKey}" (${this.sessions.size} active, max=${maxSessions})`);
        const evicted = this.sessions.get(oldestKey);
        evicted?.close();
        this.sessions.delete(oldestKey);
        this.sessionLastUsed.delete(oldestKey);
        this.sessionGenerations.delete(oldestKey);
        this.sessionCreationLocks.delete(oldestKey);
      } else {
        // All existing sessions are active; allow temporary overflow.
        log.debug(`LRU session eviction skipped: all ${this.sessions.size} sessions are active/in-flight`);
      }
    }

    this.sessions.set(key, session);
    this.sessionLastUsed.set(key, Date.now());
    return session;
  }

  /** Legacy convenience: resolve key from shared/per-channel mode and delegate. */
  private async ensureSession(): Promise<Session> {
    return this.ensureSessionForKey('shared');
  }

  /**
   * Destroy session(s). If key provided, destroys only that key.
   * If key is undefined, destroys ALL sessions.
   */
  private invalidateSession(key?: string): void {
    if (key) {
      // Invalidate any in-flight creation for this key so reset can force
      // a fresh conversation/session immediately.
      const nextGeneration = (this.sessionGenerations.get(key) ?? 0) + 1;
      this.sessionGenerations.set(key, nextGeneration);
      this.sessionCreationLocks.delete(key);

      const session = this.sessions.get(key);
      if (session) {
        log.info(`Invalidating session (key=${key})`);
        session.close();
        this.sessions.delete(key);
        this.sessionLastUsed.delete(key);
      }
    } else {
      const keys = new Set<string>([
        ...this.sessions.keys(),
        ...this.sessionCreationLocks.keys(),
      ]);
      for (const k of keys) {
        const nextGeneration = (this.sessionGenerations.get(k) ?? 0) + 1;
        this.sessionGenerations.set(k, nextGeneration);
      }

      for (const [k, session] of this.sessions) {
        log.info(`Invalidating session (key=${k})`);
        session.close();
      }
      this.sessions.clear();
      this.sessionCreationLocks.clear();
      this.sessionLastUsed.clear();
    }
  }

  /**
   * Pre-warm the session subprocess at startup. Call after config/agent is loaded.
   */
  async warmSession(): Promise<void> {
    this.store.refresh();
    if (!this.store.agentId && !this.store.conversationId) return;
    try {
      const mode = this.config.conversationMode || 'shared';
      // In shared mode, warm the single session. In per-channel/per-chat modes,
      // warm nothing (sessions are created on first message per key).
      if (mode === 'shared') {
        await this.ensureSessionForKey('shared');
      }
    } catch (err) {
      log.warn('Session pre-warm failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Persist conversation ID after a successful session result.
   * Agent ID and first-run setup are handled eagerly in ensureSessionForKey().
   */
  private persistSessionState(session: Session, convKey?: string): void {
    // Agent ID already persisted in ensureSessionForKey() on creation.
    // Here we only update if the server returned a different one (shouldn't happen).
    if (session.agentId && session.agentId !== this.store.agentId) {
      const currentBaseUrl = process.env.LETTA_BASE_URL || 'https://api.letta.com';
      this.store.setAgent(session.agentId, currentBaseUrl, session.conversationId || undefined);
      log.info('Agent ID updated:', session.agentId);
    } else if (session.conversationId) {
      // In per-channel mode, persist per-key. In shared mode, use legacy field.
      if (convKey && convKey !== 'shared') {
        const existing = this.store.getConversationId(convKey);
        if (session.conversationId !== existing) {
          this.store.setConversationId(convKey, session.conversationId);
          log.info(`Conversation ID updated (key=${convKey}):`, session.conversationId);
        }
      } else if (session.conversationId !== this.store.conversationId) {
        this.store.conversationId = session.conversationId;
        log.info('Conversation ID updated:', session.conversationId);
      }
    }
  }

  /**
   * Send a message and return a deduplicated stream.
   * 
   * Handles:
   * - Persistent session reuse (subprocess stays alive across messages)
   * - CONFLICT recovery from orphaned approvals (retry once)
   * - Conversation-not-found fallback (create new conversation)
   * - Tool call deduplication
   * - Session persistence after result
   */
  private async runSession(
    message: SendMessage,
    options: { retried?: boolean; canUseTool?: CanUseToolCallback; convKey?: string } = {},
  ): Promise<{ session: Session; stream: () => AsyncGenerator<StreamMsg> }> {
    const { retried = false, canUseTool, convKey = 'shared' } = options;

    // Update the per-message callback before sending
    this.currentCanUseTool = canUseTool;

    let session = await this.ensureSessionForKey(convKey);

    // Resolve the conversation ID for this key (for error recovery)
    const convId = convKey === 'shared'
      ? this.store.conversationId
      : this.store.getConversationId(convKey);

    // Send message with fallback chain
    try {
      await this.withSessionTimeout(session.send(message), `Session send (key=${convKey})`);
    } catch (error) {
      // 409 CONFLICT from orphaned approval
      if (!retried && isApprovalConflictError(error) && this.store.agentId && convId) {
        log.info('CONFLICT detected - attempting orphaned approval recovery...');
        this.invalidateSession(convKey);
        const result = await recoverOrphanedConversationApproval(
          this.store.agentId,
          convId
        );
        if (result.recovered) {
          log.info(`Recovery succeeded (${result.details}), retrying...`);
          return this.runSession(message, { retried: true, canUseTool, convKey });
        }
        log.error(`Orphaned approval recovery failed: ${result.details}`);
        throw error;
      }

      // Conversation/agent not found - try creating a new conversation.
      // Only retry on errors that indicate missing conversation/agent, not
      // on auth, network, or protocol errors (which would just fail again).
      if (this.store.agentId && isConversationMissingError(error)) {
        log.warn(`Conversation not found (key=${convKey}), creating a new conversation...`);
        this.invalidateSession(convKey);
        if (convKey !== 'shared') {
          this.store.clearConversation(convKey);
        } else {
          this.store.conversationId = null;
        }
        session = await this.ensureSessionForKey(convKey);
        try {
          await this.withSessionTimeout(session.send(message), `Session send retry (key=${convKey})`);
        } catch (retryError) {
          this.invalidateSession(convKey);
          throw retryError;
        }
      } else {
        // Unknown error -- invalidate so we get a fresh subprocess next time
        this.invalidateSession(convKey);
        throw error;
      }
    }

    // Persist conversation ID immediately after successful send, before streaming.
    this.persistSessionState(session, convKey);

    // Return session and a stream generator that buffers tool_call chunks and
    // flushes them with fully accumulated arguments on the next type boundary.
    // This ensures display messages always have complete args (channels can't
    // edit messages after sending).
    const pendingToolCalls = new Map<string, { msg: StreamMsg; accumulatedArgs: string }>();
    const self = this;
    const capturedConvKey = convKey; // Capture for closure

    /** Merge tool argument strings, handling both delta and cumulative chunking. */
    function mergeToolArgs(existing: string, incoming: string): string {
      if (!incoming) return existing;
      if (!existing) return incoming;
      if (incoming === existing) return existing;
      // Cumulative: latest chunk includes all prior text
      if (incoming.startsWith(existing)) return incoming;
      if (existing.endsWith(incoming)) return existing;
      // Delta: each chunk is an append
      return `${existing}${incoming}`;
    }

    function* flushPending(): Generator<StreamMsg> {
      for (const [, pending] of pendingToolCalls) {
        if (!pending.accumulatedArgs) {
          // No rawArguments accumulated (old SDK or single complete chunk) --
          // preserve the original toolInput from the first chunk as-is.
          yield pending.msg;
          continue;
        }
        let toolInput: Record<string, unknown> = {};
        try { toolInput = JSON.parse(pending.accumulatedArgs); }
        catch { toolInput = { raw: pending.accumulatedArgs }; }
        yield { ...pending.msg, toolInput };
      }
      pendingToolCalls.clear();
      lastPendingToolCallId = null;
    }

    let anonToolCallCounter = 0;
    let lastPendingToolCallId: string | null = null;

    async function* dedupedStream(): AsyncGenerator<StreamMsg> {
      for await (const raw of session.stream()) {
        const msg = raw as StreamMsg;

        if (msg.type === 'tool_call') {
          let id = msg.toolCallId;
          if (!id) {
            // Tool calls without IDs (e.g., from models that don't emit
            // tool_call_id on subsequent argument chunks) still need to be
            // accumulated. Assign a synthetic ID so they enter the buffer.
            // If tool name matches the most recent pending call, treat this as
            // a continuation even when the first chunk had a real toolCallId.
            const currentPending = lastPendingToolCallId ? pendingToolCalls.get(lastPendingToolCallId) : null;
            if (lastPendingToolCallId && currentPending && (currentPending.msg.toolName || 'unknown') === (msg.toolName || 'unknown')) {
              id = lastPendingToolCallId;
            } else {
              id = `__anon_${++anonToolCallCounter}__`;
            }
          }

          const incoming = (msg as StreamMsg & { rawArguments?: string }).rawArguments || '';
          const existing = pendingToolCalls.get(id);
          if (existing) {
            existing.accumulatedArgs = mergeToolArgs(existing.accumulatedArgs, incoming);
          } else {
            pendingToolCalls.set(id, { msg, accumulatedArgs: incoming });
          }
          lastPendingToolCallId = id;
          continue; // buffer, don't yield yet
        }

        // Flush pending tool calls on semantic type boundary (not stream_event)
        if (pendingToolCalls.size > 0 && msg.type !== 'stream_event') {
          yield* flushPending();
        }

        if (msg.type === 'result') {
          // Flush any remaining before result
          yield* flushPending();
          self.persistSessionState(session, capturedConvKey);
        }

        yield msg;

        if (msg.type === 'result') {
          break;
        }
      }

      // Flush remaining at generator end (shouldn't normally happen)
      yield* flushPending();
    }

    return { session, stream: dedupedStream };
  }

  // =========================================================================
  // Channel management
  // =========================================================================

  registerChannel(adapter: ChannelAdapter): void {
    adapter.onMessage = (msg) => this.handleMessage(msg, adapter);
    adapter.onCommand = (cmd, chatId, args) => this.handleCommand(cmd, adapter.id, chatId, args);

    // Wrap outbound methods when any redaction layer is active.
    // Secrets are enabled by default unless explicitly disabled.
    const redactionConfig = this.config.redaction;
    const shouldRedact = redactionConfig?.secrets !== false || redactionConfig?.pii === true;
    if (shouldRedact) {
      const origSend = adapter.sendMessage.bind(adapter);
      adapter.sendMessage = (msg) => origSend({ ...msg, text: redactOutbound(msg.text, redactionConfig) });

      const origEdit = adapter.editMessage.bind(adapter);
      adapter.editMessage = (chatId, messageId, text) => origEdit(chatId, messageId, redactOutbound(text, redactionConfig));
    }

    this.channels.set(adapter.id, adapter);
    log.info(`Registered channel: ${adapter.name}`);
  }
  
  setGroupBatcher(batcher: GroupBatcher, intervals: Map<string, number>, instantGroupIds?: Set<string>, listeningGroupIds?: Set<string>): void {
    this.groupBatcher = batcher;
    this.groupIntervals = intervals;
    if (instantGroupIds) {
      this.instantGroupIds = instantGroupIds;
    }
    if (listeningGroupIds) {
      this.listeningGroupIds = listeningGroupIds;
    }
    log.info('Group batcher configured');
  }

  processGroupBatch(msg: InboundMessage, adapter: ChannelAdapter): void {
    const count = msg.batchedMessages?.length || 0;
    log.info(`Group batch: ${count} messages from ${msg.channel}:${msg.chatId}`);
    const effective = (count === 1 && msg.batchedMessages)
      ? msg.batchedMessages[0]
      : msg;

    // Legacy listeningGroups fallback (new mode-based configs set isListeningMode in adapters)
    if (effective.isListeningMode === undefined) {
      const isListening = this.listeningGroupIds.has(`${msg.channel}:${msg.chatId}`)
        || (msg.serverId && this.listeningGroupIds.has(`${msg.channel}:${msg.serverId}`));
      if (isListening && !msg.wasMentioned) {
        effective.isListeningMode = true;
      }
    }

    const convKey = this.resolveConversationKey(effective.channel, effective.chatId);
    if (convKey !== 'shared') {
      this.enqueueForKey(convKey, effective, adapter);
    } else {
      this.messageQueue.push({ msg: effective, adapter });
      if (!this.processing) {
        this.processQueue().catch(err => log.error('Fatal error in processQueue:', err));
      }
    }
  }

  // =========================================================================
  // Commands
  // =========================================================================

  private async handleCommand(command: string, channelId?: string, chatId?: string, args?: string): Promise<string | null> {
    log.info(`Received: /${command}${args ? ` ${args}` : ''}`);
    switch (command) {
      case 'status': {
        const info = this.store.getInfo();
        const lines = [
          `*Status*`,
          `Agent ID: \`${info.agentId || '(none)'}\``,
          `Created: ${info.createdAt || 'N/A'}`,
          `Last used: ${info.lastUsedAt || 'N/A'}`,
          `Channels: ${Array.from(this.channels.keys()).join(', ')}`,
        ];
        return lines.join('\n');
      }
      case 'heartbeat': {
        if (!this.onTriggerHeartbeat) {
          return '⚠️ Heartbeat service not configured';
        }
        this.onTriggerHeartbeat().catch(err => {
          log.error('Manual trigger failed:', err);
        });
        return '⏰ Heartbeat triggered (silent mode - check server logs)';
      }
      case 'reset': {
        // Always scope the reset to the caller's conversation key so that
        // other channels/chats' conversations are never silently destroyed.
        // resolveConversationKey returns 'shared' for non-override channels,
        // the channel id for per-channel, or channel:chatId for per-chat.
        const convKey = channelId ? this.resolveConversationKey(channelId, chatId) : 'shared';
        this.store.clearConversation(convKey);
        this.store.resetRecoveryAttempts();
        this.invalidateSession(convKey);
        log.info(`/reset - conversation cleared for key="${convKey}"`);
        // Eagerly create the new session so we can report the conversation ID.
        try {
          const session = await this.ensureSessionForKey(convKey);
          const newConvId = session.conversationId || '(pending)';
          this.persistSessionState(session, convKey);
          if (convKey === 'shared') {
            return `Conversation reset. New conversation: ${newConvId}\n(Agent memory is preserved.)`;
          }
          const scope = this.config.conversationMode === 'per-chat' ? 'this chat' : 'this channel';
          return `Conversation reset for ${scope}. New conversation: ${newConvId}\nOther conversations are unaffected. (Agent memory is preserved.)`;
        } catch {
          if (convKey === 'shared') {
            return 'Conversation reset. Send a message to start a new conversation. (Agent memory is preserved.)';
          }
          const scope = this.config.conversationMode === 'per-chat' ? 'this chat' : 'this channel';
          return `Conversation reset for ${scope}. Other conversations are unaffected. (Agent memory is preserved.)`;
        }
      }
      case 'cancel': {
        const convKey = channelId ? this.resolveConversationKey(channelId, chatId) : 'shared';

        // Check if there's actually an active run for this conversation key
        if (!this.processingKeys.has(convKey) && !this.processing) {
          return '(Nothing to cancel -- no active run.)';
        }

        // Signal the stream loop to break
        this.cancelledKeys.add(convKey);

        // Abort client-side stream
        const session = this.sessions.get(convKey);
        if (session) {
          session.abort().catch(() => {});
          log.info(`/cancel - aborted session stream (key=${convKey})`);
        }

        // Cancel server-side run (conversation-scoped)
        const convId = convKey === 'shared'
          ? this.store.conversationId
          : this.store.getConversationId(convKey);
        if (convId) {
          const ok = await cancelConversation(convId);
          if (!ok) {
            return '(Run cancelled locally, but server-side cancellation failed.)';
          }
        }

        log.info(`/cancel - run cancelled (key=${convKey})`);
        return '(Run cancelled.)';
      }
      case 'model': {
        const agentId = this.store.agentId;
        if (!agentId) return 'No agent configured.';

        if (args) {
          const success = await updateAgentModel(agentId, args);
          if (success) {
            return `Model updated to: ${args}`;
          }
          return 'Failed to update model. Check the handle is valid.\nUse /model to list available models.';
        }

        const current = await getAgentModel(agentId);
        const { models: recommendedModels } = await import('../utils/model-selection.js');
        const lines = [
          `Current model: ${current || '(unknown)'}`,
          '',
          'Recommended models:',
        ];
        for (const m of recommendedModels) {
          const marker = m.handle === current ? ' (current)' : '';
          lines.push(`  ${m.label} - ${m.handle}${marker}`);
        }
        lines.push('', 'Use /model <handle> to switch.');
        return lines.join('\n');
      }
      default:
        return null;
    }
  }

  // =========================================================================
  // Start / Stop
  // =========================================================================
  
  async start(): Promise<void> {
    const startPromises = Array.from(this.channels.entries()).map(async ([id, adapter]) => {
      try {
        log.info(`Starting channel: ${adapter.name}...`);
        await adapter.start();
        log.info(`Started channel: ${adapter.name}`);
      } catch (e) {
        log.error(`Failed to start channel ${id}:`, e);
      }
    });
    await Promise.all(startPromises);
  }
  
  async stop(): Promise<void> {
    for (const adapter of this.channels.values()) {
      try {
        await adapter.stop();
      } catch (e) {
        log.error(`Failed to stop channel ${adapter.id}:`, e);
      }
    }
  }

  // =========================================================================
  // Approval recovery
  // =========================================================================
  
  private async attemptRecovery(maxAttempts = 2): Promise<{ recovered: boolean; shouldReset: boolean }> {
    if (!this.store.agentId) {
      return { recovered: false, shouldReset: false };
    }
    
    log.info('Checking for pending approvals...');
    
    try {
      const pendingApprovals = await getPendingApprovals(
        this.store.agentId,
        this.store.conversationId || undefined
      );
      
      if (pendingApprovals.length === 0) {
        if (this.store.conversationId) {
          const convResult = await recoverOrphanedConversationApproval(
            this.store.agentId!,
            this.store.conversationId
          );
          if (convResult.recovered) {
            log.info(`Conversation-level recovery succeeded: ${convResult.details}`);
            return { recovered: true, shouldReset: false };
          }
        }
        this.store.resetRecoveryAttempts();
        return { recovered: false, shouldReset: false };
      }
      
      const attempts = this.store.recoveryAttempts;
      if (attempts >= maxAttempts) {
        log.error(`Recovery failed after ${attempts} attempts. Still have ${pendingApprovals.length} pending approval(s).`);
        return { recovered: false, shouldReset: true };
      }
      
      log.info(`Found ${pendingApprovals.length} pending approval(s), attempting recovery (attempt ${attempts + 1}/${maxAttempts})...`);
      this.store.incrementRecoveryAttempts();
      
      for (const approval of pendingApprovals) {
        log.info(`Rejecting approval for ${approval.toolName} (${approval.toolCallId})`);
        await rejectApproval(
          this.store.agentId,
          { toolCallId: approval.toolCallId, reason: 'Session was interrupted - retrying request' },
          this.store.conversationId || undefined
        );
      }
      
      const runIds = [...new Set(pendingApprovals.map(a => a.runId))];
      if (runIds.length > 0) {
        log.info(`Cancelling ${runIds.length} active run(s)...`);
        await cancelRuns(this.store.agentId, runIds);
      }
      
      log.info('Recovery completed');
      return { recovered: true, shouldReset: false };
      
    } catch (error) {
      log.error('Recovery failed:', error);
      this.store.incrementRecoveryAttempts();
      return { recovered: false, shouldReset: this.store.recoveryAttempts >= maxAttempts };
    }
  }

  // =========================================================================
  // Message queue
  // =========================================================================
  
  private async handleMessage(msg: InboundMessage, adapter: ChannelAdapter): Promise<void> {
    // AskUserQuestion support: if the agent is waiting for a user answer,
    // intercept this message and resolve the pending promise instead of
    // queuing it for normal processing. This prevents a deadlock where
    // the stream is paused waiting for user input while the processing
    // flag blocks new messages from being handled.
    const incomingConvKey = this.resolveConversationKey(msg.channel, msg.chatId);
    const pendingResolver = this.pendingQuestionResolvers.get(incomingConvKey);
    if (pendingResolver) {
      log.info(`Intercepted message as AskUserQuestion answer from ${msg.userId} (key=${incomingConvKey})`);
      pendingResolver(msg.text || '');
      this.pendingQuestionResolvers.delete(incomingConvKey);
      return;
    }

    log.info(`Message from ${msg.userId} on ${msg.channel}: ${msg.text}`);

    if (msg.isGroup && this.groupBatcher) {
      const isInstant = this.instantGroupIds.has(`${msg.channel}:${msg.chatId}`)
        || (msg.serverId && this.instantGroupIds.has(`${msg.channel}:${msg.serverId}`));
      const debounceMs = isInstant ? 0 : (this.groupIntervals.get(msg.channel) ?? 5000);
      log.info(`Group message routed to batcher (debounce=${debounceMs}ms, mentioned=${msg.wasMentioned}, instant=${!!isInstant})`);
      this.groupBatcher.enqueue(msg, adapter, debounceMs);
      return;
    }

    const convKey = this.resolveConversationKey(msg.channel, msg.chatId);
    if (convKey !== 'shared') {
      // Per-channel, per-chat, or override mode: messages on different keys can run in parallel.
      this.enqueueForKey(convKey, msg, adapter);
    } else {
      // Shared mode: single global queue (existing behavior)
      this.messageQueue.push({ msg, adapter });
      if (!this.processing) {
        this.processQueue().catch(err => log.error('Fatal error in processQueue:', err));
      }
    }
  }

  /**
   * Enqueue a message for a specific conversation key.
   * Messages with the same key are serialized; different keys run in parallel.
   */
  private keyedQueues: Map<string, Array<{ msg: InboundMessage; adapter: ChannelAdapter }>> = new Map();

  private enqueueForKey(key: string, msg: InboundMessage, adapter: ChannelAdapter): void {
    let queue = this.keyedQueues.get(key);
    if (!queue) {
      queue = [];
      this.keyedQueues.set(key, queue);
    }
    queue.push({ msg, adapter });

    if (!this.processingKeys.has(key)) {
      this.processKeyedQueue(key).catch(err =>
        log.error(`Fatal error in processKeyedQueue(${key}):`, err)
      );
    }
  }

  private async processKeyedQueue(key: string): Promise<void> {
    if (this.processingKeys.has(key)) return;
    this.processingKeys.add(key);

    const queue = this.keyedQueues.get(key);
    while (queue && queue.length > 0) {
      const { msg, adapter } = queue.shift()!;
      try {
        await this.processMessage(msg, adapter);
      } catch (error) {
        log.error(`Error processing message (key=${key}):`, error);
      }
    }

    this.processingKeys.delete(key);
    this.keyedQueues.delete(key);
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.messageQueue.length === 0) return;
    
    this.processing = true;
    
    while (this.messageQueue.length > 0) {
      const { msg, adapter } = this.messageQueue.shift()!;
      try {
        await this.processMessage(msg, adapter);
      } catch (error) {
        log.error('Error processing message:', error);
      }
    }
    
    log.info('Finished processing all messages');
    this.processing = false;
  }

  // =========================================================================
  // processMessage - User-facing message handling
  // =========================================================================
  
  private async processMessage(msg: InboundMessage, adapter: ChannelAdapter, retried = false): Promise<void> {
    // Track timing and last target
    const debugTiming = !!process.env.LETTABOT_DEBUG_TIMING;
    const t0 = debugTiming ? performance.now() : 0;
    const lap = (label: string) => {
      log.debug(`${label}: ${(performance.now() - t0).toFixed(0)}ms`);
    };
    const suppressDelivery = isResponseDeliverySuppressed(msg);
    this.lastUserMessageTime = new Date();

    // Skip heartbeat target update for listening mode (don't redirect heartbeats)
    if (!suppressDelivery) {
      this.store.lastMessageTarget = {
        channel: msg.channel,
        chatId: msg.chatId,
        messageId: msg.messageId,
        updatedAt: new Date().toISOString(),
      };
    }

    // Fire-and-forget typing indicator so session creation starts immediately
    if (!suppressDelivery) {
      adapter.sendTypingIndicator(msg.chatId).catch(() => {});
    }
    lap('typing indicator');

    // Pre-send approval recovery (secondary defense).
    // Primary detection is now in ensureSessionForKey() via bootstrapState().
    // This fallback only fires when previous failures incremented recoveryAttempts,
    // covering edge cases where a cached session encounters a new stuck approval.
    const recovery = this.store.recoveryAttempts > 0
      ? await this.attemptRecovery()
      : { recovered: false, shouldReset: false };
    lap('recovery check');
    if (recovery.shouldReset) {
      if (!suppressDelivery) {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `(I had trouble processing that -- the session hit a stuck state and automatic recovery failed after ${this.store.recoveryAttempts} attempt(s). Please try sending your message again. If this keeps happening, /reset will clear the conversation for this channel.)`,
          threadId: msg.threadId,
        });
      }
      return;
    }

    // Format message with metadata envelope
    const prevTarget = this.store.lastMessageTarget;
    const isNewChatSession = !prevTarget || prevTarget.chatId !== msg.chatId || prevTarget.channel !== msg.channel;
    const sessionContext: SessionContextOptions | undefined = isNewChatSession ? {
      agentId: this.store.agentId || undefined,
      serverUrl: process.env.LETTA_BASE_URL || this.store.baseUrl || 'https://api.letta.com',
    } : undefined;

    const formattedText = msg.isBatch && msg.batchedMessages
      ? formatGroupBatchEnvelope(msg.batchedMessages, {}, msg.isListeningMode)
      : formatMessageEnvelope(msg, {}, sessionContext);
    const messageToSend = await buildMultimodalMessage(formattedText, msg);
    lap('format message');

    // Build AskUserQuestion-aware canUseTool callback with channel context.
    // In bypassPermissions mode, this callback is only invoked for interactive
    // tools (AskUserQuestion, ExitPlanMode) -- normal tools are auto-approved.
    const canUseTool: CanUseToolCallback = async (toolName, toolInput) => {
      if (toolName === 'AskUserQuestion') {
        const questions = (toolInput.questions || []) as Array<{
          question: string;
          header: string;
          options: Array<{ label: string; description: string }>;
          multiSelect: boolean;
        }>;
        const questionText = this.formatQuestionsForChannel(questions);
        log.info(`AskUserQuestion: sending ${questions.length} question(s) to ${msg.channel}:${msg.chatId}`);
        await adapter.sendMessage({ chatId: msg.chatId, text: questionText, threadId: msg.threadId });

        // Wait for the user's next message (intercepted by handleMessage).
        // Key by convKey so each chat resolves independently in per-chat mode.
        const questionConvKey = this.resolveConversationKey(msg.channel, msg.chatId);
        const answer = await new Promise<string>((resolve) => {
          this.pendingQuestionResolvers.set(questionConvKey, resolve);
        });
        log.info(`AskUserQuestion: received answer (${answer.length} chars)`);

        // Map the user's response to each question
        const answers: Record<string, string> = {};
        for (const q of questions) {
          answers[q.question] = answer;
        }
        return {
          behavior: 'allow' as const,
          updatedInput: { ...toolInput, answers },
        };
      }
      // All other interactive tools: allow by default
      return { behavior: 'allow' as const };
    };

    // Run session
    let session: Session | null = null;
    try {
      const convKey = this.resolveConversationKey(msg.channel, msg.chatId);
      const run = await this.runSession(messageToSend, { retried, canUseTool, convKey });
      lap('session send');
      session = run.session;

      // Stream response with delivery
      let response = '';
      let lastUpdate = 0; // Start at 0 so the first streaming edit fires immediately
      let messageId: string | null = null;
      let lastMsgType: string | null = null;
      let lastAssistantUuid: string | null = null;
      let sentAnyMessage = false;
      let receivedAnyData = false;
      let sawNonAssistantSinceLastUuid = false;
      let lastErrorDetail: { message: string; stopReason: string; apiError?: Record<string, unknown> } | null = null;
      let retryInfo: { attempt: number; maxAttempts: number; reason: string } | null = null;
      let reasoningBuffer = '';
      const msgTypeCounts: Record<string, number> = {};

      const parseAndHandleDirectives = async () => {
        if (!response.trim()) return;
        const { cleanText, directives } = parseDirectives(response);
        response = cleanText;
        if (directives.length === 0) return;

        if (suppressDelivery) {
          log.info(`Listening mode: skipped ${directives.length} directive(s)`);
          return;
        }

        if (await this.executeDirectives(directives, adapter, msg.chatId, msg.messageId, msg.threadId)) {
          sentAnyMessage = true;
        }
      };
      
      const finalizeMessage = async () => {
        // Parse and execute XML directives before sending
        await parseAndHandleDirectives();

        // Check for no-reply AFTER directive parsing
        if (response.trim() === '<no-reply/>') {
          log.info('Agent chose not to reply (no-reply marker)');
          sentAnyMessage = true;
          response = '';
          messageId = null;
          lastUpdate = Date.now();
          return;
        }

        if (!suppressDelivery && response.trim()) {
          try {
            const prefixed = this.prefixResponse(response);
            if (messageId) {
              await adapter.editMessage(msg.chatId, messageId, prefixed);
            } else {
              await adapter.sendMessage({ chatId: msg.chatId, text: prefixed, threadId: msg.threadId });
            }
            sentAnyMessage = true;
          } catch {
            if (messageId) sentAnyMessage = true;
          }
        }
        response = '';
        messageId = null;
        lastUpdate = Date.now();
      };
      
      const typingInterval = setInterval(() => {
        adapter.sendTypingIndicator(msg.chatId).catch(() => {});
      }, 4000);
      
      try {
        let firstChunkLogged = false;
        for await (const streamMsg of run.stream()) {
          // Check for /cancel before processing each chunk
          if (this.cancelledKeys.has(convKey)) {
            log.info(`Stream cancelled by /cancel (key=${convKey})`);
            break;
          }
          if (!firstChunkLogged) { lap('first stream chunk'); firstChunkLogged = true; }
          receivedAnyData = true;
          msgTypeCounts[streamMsg.type] = (msgTypeCounts[streamMsg.type] || 0) + 1;
          
          const preview = JSON.stringify(streamMsg).slice(0, 300);
          if (streamMsg.type === 'reasoning' || streamMsg.type === 'assistant') {
            log.debug(`type=${streamMsg.type} ${preview}`);
          } else {
            log.info(`type=${streamMsg.type} ${preview}`);
          }
          
          // stream_event is a low-level streaming primitive (partial deltas), not a
          // semantic type change. Skip it for type-transition logic so it doesn't
          // prematurely flush reasoning buffers or finalize assistant messages.
          const isSemanticType = streamMsg.type !== 'stream_event';

          // Finalize on type change (avoid double-handling when result provides full response)
          if (isSemanticType && lastMsgType && lastMsgType !== streamMsg.type && response.trim() && streamMsg.type !== 'result') {
            await finalizeMessage();
          }

          // Flush reasoning buffer when type changes away from reasoning
          if (isSemanticType && lastMsgType === 'reasoning' && streamMsg.type !== 'reasoning' && reasoningBuffer.trim()) {
            log.info(`Reasoning: ${reasoningBuffer.trim()}`);
            if (this.config.display?.showReasoning && !suppressDelivery) {
              try {
                const reasoning = this.formatReasoningDisplay(reasoningBuffer, adapter.id);
                await adapter.sendMessage({ chatId: msg.chatId, text: reasoning.text, threadId: msg.threadId, parseMode: reasoning.parseMode });
                // Note: display messages don't set sentAnyMessage -- they're informational,
                // not a substitute for an assistant response. Error handling and retry must
                // still fire even if reasoning was displayed.
              } catch (err) {
                log.warn('Failed to send reasoning display:', err instanceof Error ? err.message : err);
              }
            }
            reasoningBuffer = '';
          }

          // (Tool call displays fire immediately in the tool_call handler below.)
          
          // Tool loop detection
          const maxToolCalls = this.config.maxToolCalls ?? 100;
          if (streamMsg.type === 'tool_call' && (msgTypeCounts['tool_call'] || 0) >= maxToolCalls) {
            log.error(`Agent stuck in tool loop (${msgTypeCounts['tool_call']} calls), aborting`);
            session.abort().catch(() => {});
            response = '(Agent got stuck in a tool loop and was stopped. Try sending your message again.)';
            break;
          }

          // Log meaningful events with structured summaries
          if (streamMsg.type === 'tool_call') {
            this.syncTodoToolCall(streamMsg);
            const tcName = streamMsg.toolName || 'unknown';
            const tcId = streamMsg.toolCallId?.slice(0, 12) || '?';
            log.info(`>>> TOOL CALL: ${tcName} (id: ${tcId})`);
            sawNonAssistantSinceLastUuid = true;
            // Display tool call (args are fully accumulated by dedupedStream buffer-and-flush)
            if (this.config.display?.showToolCalls && !suppressDelivery) {
              try {
                const text = this.formatToolCallDisplay(streamMsg);
                await adapter.sendMessage({ chatId: msg.chatId, text, threadId: msg.threadId });
              } catch (err) {
                log.warn('Failed to send tool call display:', err instanceof Error ? err.message : err);
              }
            }
          } else if (streamMsg.type === 'tool_result') {
            log.info(`<<< TOOL RESULT: error=${streamMsg.isError}, len=${(streamMsg as any).content?.length || 0}`);
            sawNonAssistantSinceLastUuid = true;
          } else if (streamMsg.type === 'assistant' && lastMsgType !== 'assistant') {
            log.info(`Generating response...`);
          } else if (streamMsg.type === 'reasoning') {
            if (lastMsgType !== 'reasoning') {
              log.info(`Reasoning...`);
            }
            sawNonAssistantSinceLastUuid = true;
            // Accumulate reasoning content for display
            if (this.config.display?.showReasoning) {
              reasoningBuffer += streamMsg.content || '';
            }
          } else if (streamMsg.type === 'error') {
            // SDK now surfaces error detail that was previously dropped.
            // Store for use in the user-facing error message.
            lastErrorDetail = {
              message: (streamMsg as any).message || 'unknown',
              stopReason: (streamMsg as any).stopReason || 'error',
              apiError: (streamMsg as any).apiError,
            };
            log.error(`Stream error detail: ${lastErrorDetail.message} [${lastErrorDetail.stopReason}]`);
            sawNonAssistantSinceLastUuid = true;
          } else if (streamMsg.type === 'retry') {
            const rm = streamMsg as any;
            retryInfo = { attempt: rm.attempt, maxAttempts: rm.maxAttempts, reason: rm.reason };
            log.info(`Retrying (${rm.attempt}/${rm.maxAttempts}): ${rm.reason}`);
            sawNonAssistantSinceLastUuid = true;
          } else if (streamMsg.type !== 'assistant') {
            sawNonAssistantSinceLastUuid = true;
          }
          // Don't let stream_event overwrite lastMsgType -- it's noise between
          // semantic types and would cause false type-transition triggers.
          if (isSemanticType) lastMsgType = streamMsg.type;
          
          if (streamMsg.type === 'assistant') {
            const msgUuid = streamMsg.uuid;
            if (msgUuid && lastAssistantUuid && msgUuid !== lastAssistantUuid) {
              if (response.trim()) {
                if (!sawNonAssistantSinceLastUuid) {
                  log.warn(`WARNING: Assistant UUID changed (${lastAssistantUuid.slice(0, 8)} -> ${msgUuid.slice(0, 8)}) with no visible tool_call/reasoning events between them. Tool call events may have been dropped by SDK transformMessage().`);
                }
                await finalizeMessage();
              }
              // Start tracking tool/reasoning visibility for the new assistant UUID.
              sawNonAssistantSinceLastUuid = false;
            } else if (msgUuid && !lastAssistantUuid) {
              // Clear any pre-assistant noise so the first UUID becomes a clean baseline.
              sawNonAssistantSinceLastUuid = false;
            }
            lastAssistantUuid = msgUuid || lastAssistantUuid;
            
            response += streamMsg.content || '';
            
            // Live-edit streaming for channels that support it
            // Hold back streaming edits while response could still be <no-reply/> or <actions> block
            const canEdit = adapter.supportsEditing?.() ?? true;
            const trimmed = response.trim();
            const mayBeHidden = '<no-reply/>'.startsWith(trimmed)
              || '<actions>'.startsWith(trimmed)
              || (trimmed.startsWith('<actions') && !trimmed.includes('</actions>'));
            // Strip any completed <actions> block from the streaming text
            const streamText = stripActionsBlock(response).trim();
            if (canEdit && !mayBeHidden && !suppressDelivery && !this.cancelledKeys.has(convKey) && streamText.length > 0 && Date.now() - lastUpdate > 500) {
              try {
                const prefixedStream = this.prefixResponse(streamText);
                if (messageId) {
                  await adapter.editMessage(msg.chatId, messageId, prefixedStream);
                } else {
                  const result = await adapter.sendMessage({ chatId: msg.chatId, text: prefixedStream, threadId: msg.threadId });
                  messageId = result.messageId;
                  sentAnyMessage = true;
                }
              } catch (editErr) {
                log.warn('Streaming edit failed:', editErr instanceof Error ? editErr.message : editErr);
              }
              lastUpdate = Date.now();
            }
          }
          
          if (streamMsg.type === 'result') {
            // Discard cancelled run results -- the server flushes accumulated
            // content from a previously cancelled run as the result for the
            // next message. Discard it and retry so the message gets processed.
            if (streamMsg.stopReason === 'cancelled') {
              log.info(`Discarding cancelled run result (len=${typeof streamMsg.result === 'string' ? streamMsg.result.length : 0})`);
              this.invalidateSession(convKey);
              session = null;
              if (!retried) {
                return this.processMessage(msg, adapter, true);
              }
              break;
            }

            const resultText = typeof streamMsg.result === 'string' ? streamMsg.result : '';
            if (resultText.trim().length > 0) {
              response = resultText;
            }
            const hasResponse = response.trim().length > 0;
            const isTerminalError = streamMsg.success === false || !!streamMsg.error;
            log.info(`Stream result: success=${streamMsg.success}, hasResponse=${hasResponse}, resultLen=${resultText.length}`);
            log.info(`Stream message counts:`, msgTypeCounts);
            if (streamMsg.error) {
              const detail = resultText.trim();
              const parts = [`error=${streamMsg.error}`];
              if (streamMsg.stopReason) parts.push(`stopReason=${streamMsg.stopReason}`);
              if (streamMsg.durationMs !== undefined) parts.push(`duration=${streamMsg.durationMs}ms`);
              if (streamMsg.conversationId) parts.push(`conv=${streamMsg.conversationId}`);
              if (detail) parts.push(`detail=${detail.slice(0, 300)}`);
              log.error(`Result error: ${parts.join(', ')}`);
            }

            // Retry once when stream ends without any assistant text.
            // This catches both empty-success and terminal-error runs.
            // TODO(letta-code-sdk#31): Remove once SDK handles HITL approvals in bypassPermissions mode.
            // Only retry if we never sent anything to the user. hasResponse tracks
            // the current buffer, but finalizeMessage() clears it on type changes.
            // sentAnyMessage is the authoritative "did we deliver output" flag.
            const nothingDelivered = !hasResponse && !sentAnyMessage;
            const retryConvKey = this.resolveConversationKey(msg.channel, msg.chatId);
            const retryConvIdFromStore = (retryConvKey === 'shared'
              ? this.store.conversationId
              : this.store.getConversationId(retryConvKey)) ?? undefined;
            const retryConvId = (typeof streamMsg.conversationId === 'string' && streamMsg.conversationId.length > 0)
              ? streamMsg.conversationId
              : retryConvIdFromStore;

            // Enrich opaque error detail from run metadata (single fast API call).
            // The wire protocol's stop_reason often just says "error" -- the run
            // metadata has the actual detail (e.g. "waiting for approval on a tool call").
            if (isTerminalError && this.store.agentId &&
                (!lastErrorDetail || lastErrorDetail.message === 'Agent stopped: error')) {
              const enriched = await getLatestRunError(this.store.agentId, retryConvId);
              if (enriched) {
                lastErrorDetail = { message: enriched.message, stopReason: enriched.stopReason };
              }
            }

            // Don't retry on 409 CONFLICT -- the conversation is busy, retrying
            // immediately will just get the same error and waste a session.
            const isConflictError = lastErrorDetail?.message?.toLowerCase().includes('conflict') || false;

            // For approval-specific conflicts, attempt recovery directly (don't
            // enter the generic retry path which would just get another CONFLICT).
            const isApprovalConflict = isConflictError &&
              lastErrorDetail?.message?.toLowerCase().includes('waiting for approval');
            if (isApprovalConflict && !retried && this.store.agentId) {
              if (retryConvId) {
                log.info('Approval conflict detected -- attempting targeted recovery...');
                this.invalidateSession(retryConvKey);
                session = null;
                clearInterval(typingInterval);
                const convResult = await recoverOrphanedConversationApproval(
                  this.store.agentId, retryConvId, true /* deepScan */
                );
                if (convResult.recovered) {
                  log.info(`Approval recovery succeeded (${convResult.details}), retrying message...`);
                  return this.processMessage(msg, adapter, true);
                }
                log.warn(`Approval recovery failed: ${convResult.details}`);
              }
            }

            // Non-retryable errors: billing, auth, not-found -- skip recovery/retry
            // entirely and surface the error to the user immediately.
            // Check both the top-level message and the nested apiError.message
            // (the billing/auth string can appear in either location).
            const errMsg = lastErrorDetail?.message?.toLowerCase() || '';
            const errApiMsg = (typeof lastErrorDetail?.apiError?.message === 'string'
              ? lastErrorDetail.apiError.message : '').toLowerCase();
            const errAny = errMsg + ' ' + errApiMsg;
            const isNonRetryableError = isTerminalError && (
              errAny.includes('out of credits') || errAny.includes('usage limit') ||
              errAny.includes('401') || errAny.includes('403') ||
              errAny.includes('unauthorized') || errAny.includes('forbidden') ||
              errAny.includes('404') ||
              ((errAny.includes('agent') || errAny.includes('conversation')) && errAny.includes('not found')) ||
              errAny.includes('rate limit') || errAny.includes('429')
            );

            const shouldRetryForEmptyResult = streamMsg.success && resultText === '' && nothingDelivered;
            const shouldRetryForErrorResult = isTerminalError && nothingDelivered && !isConflictError && !isNonRetryableError;
            if (shouldRetryForEmptyResult || shouldRetryForErrorResult) {
              if (shouldRetryForEmptyResult) {
                log.error(`Warning: Agent returned empty result with no response. stopReason=${streamMsg.stopReason || 'N/A'}, conv=${streamMsg.conversationId || 'N/A'}`);
              }
              if (shouldRetryForErrorResult) {
                log.error(`Warning: Agent returned terminal error (error=${streamMsg.error}, stopReason=${streamMsg.stopReason || 'N/A'}) with no response.`);
              }

              if (!retried && this.store.agentId && retryConvId) {
                const reason = shouldRetryForErrorResult ? 'error result' : 'empty result';
                log.info(`${reason} - attempting orphaned approval recovery...`);
                this.invalidateSession(retryConvKey);
                session = null;
                clearInterval(typingInterval);
                const convResult = await recoverOrphanedConversationApproval(
                  this.store.agentId,
                  retryConvId
                );
                if (convResult.recovered) {
                  log.info(`Recovery succeeded (${convResult.details}), retrying message...`);
                  return this.processMessage(msg, adapter, true);
                }
                log.warn(`No orphaned approvals found: ${convResult.details}`);

                // Some client-side approval failures do not surface as pending approvals.
                // Retry once anyway in case the previous run terminated mid-tool cycle.
                if (shouldRetryForErrorResult) {
                  log.info('Retrying once after terminal error (no orphaned approvals detected)...');
                  return this.processMessage(msg, adapter, true);
                }
              }
            }

            if (isTerminalError && !hasResponse && !sentAnyMessage) {
              if (lastErrorDetail) {
                response = formatApiErrorForUser(lastErrorDetail);
              } else {
                const err = streamMsg.error || 'unknown error';
                const reason = streamMsg.stopReason ? ` [${streamMsg.stopReason}]` : '';
                response = `(Agent run failed: ${err}${reason}. Try sending your message again.)`;
              }
            }
            
            break;
          }
        }
      } finally {
        clearInterval(typingInterval);
        adapter.stopTypingIndicator?.(msg.chatId)?.catch(() => {});
      }
      lap('stream complete');

      // If cancelled, clean up partial state and return early
      if (this.cancelledKeys.has(convKey)) {
        if (messageId) {
          try {
            await adapter.editMessage(msg.chatId, messageId, '(Run cancelled.)');
          } catch { /* best effort */ }
        }
        log.info(`Skipping post-stream delivery -- cancelled (key=${convKey})`);
        return;
      }

      // Parse and execute XML directives (e.g. <actions><react emoji="eyes" /></actions>)
      await parseAndHandleDirectives();

      // Handle no-reply marker AFTER directive parsing
      if (response.trim() === '<no-reply/>') {
        sentAnyMessage = true;
        response = '';
      }

      // Detect unsupported multimodal
      if (Array.isArray(messageToSend) && response.includes('[Image omitted]')) {
        log.warn('Model does not support images -- consider a vision-capable model or features.inlineImages: false');
      }

      // Listening mode: agent processed for memory, suppress response delivery
      if (suppressDelivery) {
        log.info(`Listening mode: processed ${msg.channel}:${msg.chatId} for memory (response suppressed)`);
        return;
      }

      lap('directives done');
      // Send final response
      if (response.trim()) {
        const prefixedFinal = this.prefixResponse(response);
        try {
          if (messageId) {
            await adapter.editMessage(msg.chatId, messageId, prefixedFinal);
          } else {
            await adapter.sendMessage({ chatId: msg.chatId, text: prefixedFinal, threadId: msg.threadId });
          }
          sentAnyMessage = true;
          this.store.resetRecoveryAttempts();
        } catch {
          // Edit failed -- send as new message so user isn't left with truncated text
          try {
            await adapter.sendMessage({ chatId: msg.chatId, text: prefixedFinal, threadId: msg.threadId });
            sentAnyMessage = true;
            this.store.resetRecoveryAttempts();
          } catch (retryError) {
            log.error('Retry send also failed:', retryError);
          }
        }
      }
      
      lap('message delivered');
      // Handle no response
      if (!sentAnyMessage) {
        if (!receivedAnyData) {
          log.error('Stream received NO DATA - possible stuck state');
          await adapter.sendMessage({ 
            chatId: msg.chatId, 
            text: '(No response received -- the connection may have dropped or the server may be busy. Please try again. If this persists, /reset will start a fresh conversation.)', 
            threadId: msg.threadId 
          });
        } else {
          const hadToolActivity = (msgTypeCounts['tool_call'] || 0) > 0 || (msgTypeCounts['tool_result'] || 0) > 0;
          if (hadToolActivity) {
            log.info('Agent had tool activity but no assistant message - likely sent via tool');
          } else {
            await adapter.sendMessage({ 
              chatId: msg.chatId, 
              text: '(The agent processed your message but didn\'t produce a visible response. This can happen with certain prompts. Try rephrasing or sending again.)', 
              threadId: msg.threadId 
            });
          }
        }
      }
      
    } catch (error) {
      log.error('Error processing message:', error);
      try {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          threadId: msg.threadId,
        });
      } catch (sendError) {
        log.error('Failed to send error message to channel:', sendError);
      }
    } finally {
      // Session stays alive for reuse -- only invalidated on errors
      this.cancelledKeys.delete(this.resolveConversationKey(msg.channel, msg.chatId));
    }
  }

  // =========================================================================
  // sendToAgent - Background triggers (heartbeats, cron, webhooks)
  // =========================================================================
  
  /**
   * Acquire the appropriate lock for a conversation key.
   * In per-channel mode with a dedicated key, no lock needed (parallel OK).
   * In per-channel mode with a channel key, wait for that key's queue.
   * In shared mode, use the global processing flag.
   */
  private async acquireLock(convKey: string): Promise<boolean> {
    if (convKey === 'heartbeat') return false; // No lock needed

    if (convKey !== 'shared') {
      while (this.processingKeys.has(convKey)) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      this.processingKeys.add(convKey);
    } else {
      while (this.processing) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      this.processing = true;
    }
    return true;
  }

  private releaseLock(convKey: string, acquired: boolean): void {
    if (!acquired) return;
    if (convKey !== 'shared') {
      this.processingKeys.delete(convKey);
      // Heartbeats/sendToAgent may hold a channel key while user messages for
      // that same key queue up. Kick the keyed worker after unlock so queued
      // messages are not left waiting for another inbound message to arrive.
      const queue = this.keyedQueues.get(convKey);
      if (queue && queue.length > 0) {
        this.processKeyedQueue(convKey).catch(err =>
          log.error(`Fatal error in processKeyedQueue(${convKey}) after lock release:`, err)
        );
      }
    } else {
      this.processing = false;
      this.processQueue();
    }
  }

  async sendToAgent(
    text: string,
    context?: TriggerContext
  ): Promise<string> {
    const isSilent = context?.outputMode === 'silent';
    const convKey = this.resolveHeartbeatConversationKey();
    const acquired = await this.acquireLock(convKey);
    
    try {
      const { stream } = await this.runSession(text, { convKey });
      
      try {
        let response = '';
        let lastErrorDetail: { message: string; stopReason: string; apiError?: Record<string, unknown> } | undefined;
        for await (const msg of stream()) {
          if (msg.type === 'tool_call') {
            this.syncTodoToolCall(msg);
          }
          if (msg.type === 'error') {
            lastErrorDetail = {
              message: (msg as any).message || 'unknown',
              stopReason: (msg as any).stopReason || 'error',
              apiError: (msg as any).apiError,
            };
          }
          if (msg.type === 'assistant') {
            response += msg.content || '';
          }
          if (msg.type === 'result') {
            // TODO(letta-code-sdk#31): Remove once SDK handles HITL approvals in bypassPermissions mode.
            if (msg.success === false || msg.error) {
              // Enrich opaque errors from run metadata (mirrors processMessage logic).
              const convId = typeof msg.conversationId === 'string' ? msg.conversationId : undefined;
              if (this.store.agentId &&
                  (!lastErrorDetail || lastErrorDetail.message === 'Agent stopped: error')) {
                const enriched = await getLatestRunError(this.store.agentId, convId);
                if (enriched) {
                  lastErrorDetail = { message: enriched.message, stopReason: enriched.stopReason };
                }
              }
              const errMsg = lastErrorDetail?.message || msg.error || 'error';
              const errReason = lastErrorDetail?.stopReason || msg.error || 'error';
              const detail = typeof msg.result === 'string' ? msg.result.trim() : '';
              throw new Error(detail ? `Agent run failed: ${errReason} (${errMsg})` : `Agent run failed: ${errReason} -- ${errMsg}`);
            }
            break;
          }
        }
        if (isSilent && response.trim()) {
          log.info(`Silent mode: collected ${response.length} chars (not delivered)`);
        }
        return response;
      } catch (error) {
        // Invalidate on stream errors so next call gets a fresh subprocess
        this.invalidateSession(convKey);
        throw error;
      }
    } finally {
      this.releaseLock(convKey, acquired);
    }
  }

  /**
   * Stream a message to the agent, yielding chunks as they arrive.
   * Same lifecycle as sendToAgent() but yields StreamMsg instead of accumulating.
   */
  async *streamToAgent(
    text: string,
    context?: TriggerContext
  ): AsyncGenerator<StreamMsg> {
    const convKey = this.resolveHeartbeatConversationKey();
    const acquired = await this.acquireLock(convKey);

    try {
      const { stream } = await this.runSession(text, { convKey });

      try {
        yield* stream();
      } catch (error) {
        this.invalidateSession(convKey);
        throw error;
      }
    } finally {
      this.releaseLock(convKey, acquired);
    }
  }

  // =========================================================================
  // Channel delivery + status
  // =========================================================================
  
  async deliverToChannel(
    channelId: string,
    chatId: string,
    options: {
      text?: string;
      filePath?: string;
      kind?: 'image' | 'file' | 'audio';
    }
  ): Promise<string | undefined> {
    const adapter = this.channels.get(channelId);
    if (!adapter) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    if (options.filePath) {
      if (typeof adapter.sendFile !== 'function') {
        throw new Error(`Channel ${channelId} does not support file sending`);
      }
      const result = await adapter.sendFile({
        chatId,
        filePath: options.filePath,
        caption: options.text,
        kind: options.kind,
      });
      return result.messageId;
    }

    if (options.text) {
      const result = await adapter.sendMessage({ chatId, text: this.prefixResponse(options.text) });
      return result.messageId;
    }

    throw new Error('Either text or filePath must be provided');
  }

  getStatus(): { agentId: string | null; conversationId: string | null; channels: string[] } {
    this.store.refresh();
    return {
      agentId: this.store.agentId,
      conversationId: this.store.conversationId,
      channels: Array.from(this.channels.keys()),
    };
  }
  
  setAgentId(agentId: string): void {
    this.store.agentId = agentId;
    log.info(`Agent ID set to: ${agentId}`);
  }
  
  reset(): void {
    this.store.reset();
    log.info('Agent reset');
  }
  
  getLastMessageTarget(): { channel: string; chatId: string } | null {
    return this.store.lastMessageTarget || null;
  }
  
  getLastUserMessageTime(): Date | null {
    return this.lastUserMessageTime;
  }
}
