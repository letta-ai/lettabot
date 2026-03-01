/**
 * Core Types for LettaBot
 */

import type { SendMessage } from '@letta-ai/letta-code-sdk';

// =============================================================================
// Output Control Types (NEW)
// =============================================================================

/**
 * Output mode determines whether assistant text is auto-delivered
 */
export type OutputMode = 'responsive' | 'silent';

/**
 * Trigger types
 */
export type TriggerType = 'user_message' | 'heartbeat' | 'cron' | 'webhook' | 'feed';

/**
 * Context about what triggered the agent
 */
export interface TriggerContext {
  type: TriggerType;
  outputMode: OutputMode;
  
  // Source info (for user messages)
  sourceChannel?: string;
  sourceChatId?: string;
  sourceUserId?: string;
  
  // Cron/job info
  jobId?: string;
  jobName?: string;
  
  // For cron jobs with explicit targets
  notifyTarget?: {
    channel: string;
    chatId: string;
  };
}

// =============================================================================
// Message Hooks
// =============================================================================

export type HookMode = 'await' | 'parallel';

export interface HookHandlerConfig {
  file: string;          // Path to ESM module exporting preMessage/postMessage
  mode?: HookMode;       // 'await' (default) or 'parallel'
  timeoutMs?: number;    // Optional timeout (ms)
}

export interface MessageHooksConfig {
  preMessage?: HookHandlerConfig | HookHandlerConfig[];
  postMessage?: HookHandlerConfig | HookHandlerConfig[];
  postReasoning?: HookHandlerConfig | HookHandlerConfig[];
  postToolCall?: HookHandlerConfig | HookHandlerConfig[];
  postToolResult?: HookHandlerConfig | HookHandlerConfig[];
}

export interface MessageHookContext {
  stage: 'pre' | 'postReasoning' | 'post';
  /** Unique ID for this agent turn — same value across all hook stages for the same turn */
  turnId: string;
  /**
   * Unix timestamp (ms) of when the underlying event occurred in the stream.
   * For pre: when the inbound message arrived.
   * For postReasoning: when the first chunk of this reasoning block was received.
   * For post: when the turn completed.
   * Hooks may fire later than this due to queuing; use this for accurate span timing.
   */
  timestamp: number;
  isHeartbeat: boolean;
  suppressDelivery: boolean;
  /** Whether this message is a retry of a previously failed turn */
  isRetry?: boolean;
  trigger?: TriggerContext;
  inboundMessage?: InboundMessage;
  formattedText?: string;
  message: SendMessage;
  response?: string;
  delivered?: boolean;
  error?: string;
  /** Reasoning content — populated for postReasoning stage only */
  reasoning?: string;
  /** Which reasoning block within the turn (0-based) — postReasoning stage only */
  stepIndex?: number;
  /** Total cost in USD for this turn — populated for post stage only */
  totalCostUsd?: number;
  /** Token usage for this turn — populated for post stage only */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  agent?: {
    id?: string | null;
    name?: string;
    conversationId?: string | null;
    conversationKey?: string;
  };
}

export interface ToolCallHookContext {
  /** Unique ID for this agent turn — same value across all hook stages for the same turn */
  turnId: string;
  /** Unix timestamp (ms) of when the tool_call arrived in the stream */
  timestamp: number;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolCallId?: string;
  agent?: {
    id?: string | null;
    name?: string;
    conversationId?: string | null;
    conversationKey?: string;
  };
}

export interface ToolResultHookContext {
  /** Unique ID for this agent turn — same value across all hook stages for the same turn */
  turnId: string;
  /** Unix timestamp (ms) of when the tool_result arrived in the stream */
  timestamp: number;
  toolCallId: string;
  toolName?: string;
  content: string;
  isError: boolean;
  agent?: {
    id?: string | null;
    name?: string;
    conversationId?: string | null;
    conversationKey?: string;
  };
}

// =============================================================================
// Original Types
// =============================================================================

export type ChannelId = 'telegram' | 'telegram-mtproto' | 'slack' | 'whatsapp' | 'signal' | 'discord' | 'bluesky' | 'mock';

/**
 * Message type indicating the context of the message.
 * - 'dm': Direct message (private 1:1 conversation)
 * - 'group': Group chat (multiple participants)
 * - 'public': Public post (e.g., Bluesky feed, visible to anyone)
 */
export type MessageType = 'dm' | 'group' | 'public';

export interface InboundAttachment {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: number;
  url?: string;
  localPath?: string;
  kind?: 'image' | 'file' | 'audio' | 'video';
}

export interface InboundReaction {
  emoji: string;
  messageId: string;
  action?: 'added' | 'removed';
}

/**
 * Formatter hints provided by channel adapters
 */
export interface FormatterHints {
  /** Custom format hint (overrides default channel format) */
  formatHint?: string;

  /** Whether this channel supports emoji reactions */
  supportsReactions?: boolean;

  /** Whether this channel supports file/image sending */
  supportsFiles?: boolean;

  /** Custom action hints replacing the standard Response Directives section */
  actionsSection?: string[];

  /** Whether to skip the standard Response Directives section entirely */
  skipDirectives?: boolean;
}

/**
 * Inbound message from any channel
 */
export interface InboundMessage {
  channel: ChannelId;
  chatId: string;
  userId: string;
  userName?: string;      // Display name (e.g., "Cameron")
  userHandle?: string;    // Handle/username (e.g., "cameron" for @cameron)
  messageId?: string;     // Platform-specific message ID (for reactions, etc.)
  text: string;
  timestamp: Date;
  threadId?: string;      // Slack thread_ts
  messageType?: MessageType; // 'dm', 'group', or 'public' (defaults to 'dm')
  isGroup?: boolean;      // True if group chat (convenience alias for messageType === 'group')
  groupName?: string;     // Group/channel name if applicable
  serverId?: string;      // Server/guild ID (Discord only)
  wasMentioned?: boolean; // Was bot explicitly mentioned? (groups only)
  replyToUser?: string;   // Phone number of who they're replying to (if reply)
  attachments?: InboundAttachment[];
  reaction?: InboundReaction;
  isBatch?: boolean;                  // Is this a batched group message?
  batchedMessages?: InboundMessage[]; // Original individual messages (for batch formatting)
  isListeningMode?: boolean;          // Listening mode: agent processes for memory but response is suppressed
  formatterHints?: FormatterHints;    // Channel capabilities for directive rendering
  extraContext?: Record<string, string>; // Channel-specific key/value metadata shown in Chat Context
}

/**
 * Outbound message to any channel
 */
export interface OutboundMessage {
  chatId: string;
  text: string;
  replyToMessageId?: string;
  threadId?: string;  // Slack thread_ts
  /** When set, tells the adapter which parse mode to use (e.g., 'MarkdownV2',
   *  'HTML') and to skip its default markdown conversion. Adapters that don't
   *  support the specified mode ignore this and fall back to default. */
  parseMode?: string;
}

/**
 * Outbound file/image to any channel.
 */
export interface OutboundFile {
  chatId: string;
  filePath: string;
  caption?: string;
  threadId?: string;
  kind?: 'image' | 'file' | 'audio';
}

/**
 * Skills installation config
 */
export interface SkillsConfig {
  cronEnabled?: boolean;
  googleEnabled?: boolean;
  blueskyEnabled?: boolean;
  ttsEnabled?: boolean;
  additionalSkills?: string[];
}

/**
 * Bot configuration
 */
export interface BotConfig {
  // Letta
  workingDir: string;
  agentName?: string; // Name for the agent (set via API after creation)
  allowedTools: string[];
  disallowedTools?: string[];
  hooks?: MessageHooksConfig;
  hooksDir?: string; // Base dir for resolving hook module paths

  // Display
  displayName?: string; // Prefix outbound messages (e.g. "💜 Signo")
  display?: {
    showToolCalls?: boolean;      // Show tool invocations in channel output
    showReasoning?: boolean;      // Show agent reasoning/thinking in channel output
    reasoningMaxChars?: number;   // Truncate reasoning to N chars (default: 0 = no limit)
  };

  // Skills
  skills?: SkillsConfig;

  // Safety
  maxToolCalls?: number; // Abort if agent calls this many tools in one turn (default: 100)

  // Memory filesystem (context repository)
  memfs?: boolean; // true -> --memfs, false -> --no-memfs, undefined -> leave unchanged

  // Security
  redaction?: import('./redact.js').RedactionConfig;
  allowedUsers?: string[];  // Empty = allow all
  sendFileDir?: string;     // Restrict <send-file> directive to this directory (default: data/outbound)
  sendFileMaxSize?: number; // Max file size in bytes for <send-file> (default: 50MB)
  sendFileCleanup?: boolean; // Allow <send-file cleanup="true"> to delete files after send (default: false)

  // Cron
  cronStorePath?: string; // Resolved cron store path (per-agent in multi-agent mode)

  // Conversation routing
  conversationMode?: 'shared' | 'per-channel' | 'per-chat'; // Default: shared
  heartbeatConversation?: string; // "dedicated" | "last-active" | "<channel>" (default: last-active)
  conversationOverrides?: string[]; // Channels that always use their own conversation (shared mode)
  maxSessions?: number; // Max concurrent sessions in per-chat mode (default: 10, LRU eviction)
}

/**
 * Last message target - where to deliver heartbeat responses
 */
export interface LastMessageTarget {
  channel: ChannelId;
  chatId: string;
  messageId?: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Stream message type (used by processMessage, sendToAgent, gateway)
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

/**
 * Agent store - persists the single agent ID
 */
export interface AgentStore {
  agentId: string | null;
  conversationId?: string | null; // Current conversation ID (used in shared mode)
  conversations?: Record<string, string>; // Per-key conversation IDs (used in per-channel mode)
  baseUrl?: string; // Server URL this agent belongs to
  createdAt?: string;
  lastUsedAt?: string;
  lastMessageTarget?: LastMessageTarget;
  
  // Recovery tracking
  recoveryAttempts?: number; // Count of consecutive recovery attempts
  lastRecoveryAt?: string;   // When last recovery was attempted
}
