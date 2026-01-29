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

export type ChannelId = 'telegram' | 'slack' | 'whatsapp' | 'signal' | 'discord';

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
 * Bot configuration
 */
export interface BotConfig {
  // Letta
  workingDir: string;
  model?: string; // e.g., 'anthropic/claude-sonnet-4-5-20250929'
  agentName?: string; // Name for the agent (set via API after creation)
  allowedTools: string[];
  
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
  baseUrl?: string; // Server URL this agent belongs to
  createdAt?: string;
  lastUsedAt?: string;
  lastMessageTarget?: LastMessageTarget;
}
