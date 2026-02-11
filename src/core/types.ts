/**
 * Core Types for LettaBot
 */

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
// Original Types
// =============================================================================

export type ChannelId = 'telegram' | 'slack' | 'whatsapp' | 'signal' | 'discord' | 'mock';

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
  isGroup?: boolean;      // Is this from a group chat?
  groupName?: string;     // Group/channel name if applicable
  serverId?: string;      // Server/guild ID (Discord only)
  wasMentioned?: boolean; // Was bot explicitly mentioned? (groups only)
  replyToUser?: string;   // Phone number of who they're replying to (if reply)
  attachments?: InboundAttachment[];
  reaction?: InboundReaction;
  isBatch?: boolean;                  // Is this a batched group message?
  batchedMessages?: InboundMessage[]; // Original individual messages (for batch formatting)
  isListeningMode?: boolean;          // Listening mode: agent processes for memory but response is suppressed
}

/**
 * Outbound message to any channel
 */
export interface OutboundMessage {
  chatId: string;
  text: string;
  replyToMessageId?: string;
  threadId?: string;  // Slack thread_ts
}

/**
 * Outbound file/image to any channel.
 */
export interface OutboundFile {
  chatId: string;
  filePath: string;
  caption?: string;
  threadId?: string;
  kind?: 'image' | 'file';
}

/**
 * Skills installation config
 */
export interface SkillsConfig {
  cronEnabled?: boolean;
  googleEnabled?: boolean;
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

  // Display
  displayName?: string; // Prefix outbound messages (e.g. "💜 Signo")

  // Skills
  skills?: SkillsConfig;

  // Safety
  maxToolCalls?: number; // Abort if agent calls this many tools in one turn (default: 100)

  // Security
  allowedUsers?: string[];  // Empty = allow all
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

/**
 * Agent store - persists the single agent ID
 */
export interface AgentStore {
  agentId: string | null;
  conversationId?: string | null; // Current conversation ID
  baseUrl?: string; // Server URL this agent belongs to
  createdAt?: string;
  lastUsedAt?: string;
  lastMessageTarget?: LastMessageTarget;
  
  // Recovery tracking
  recoveryAttempts?: number; // Count of consecutive recovery attempts
  lastRecoveryAt?: string;   // When last recovery was attempted
}
