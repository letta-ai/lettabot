/**
 * LettaBot Configuration Types
 *
 * Two modes:
 * 1. Self-hosted: Uses baseUrl (e.g., http://localhost:8283), no API key
 * 2. Letta Cloud: Uses apiKey, optional BYOK providers
 *
 * Two config styles:
 * 1. Legacy single-agent: Uses `agent` and `channels` at root level
 * 2. Multi-agent: Uses `agents[]` array with per-agent channel bindings
 */

// ============================================================================
// Multi-Agent Types
// ============================================================================

export type ChannelType = 'telegram' | 'slack' | 'whatsapp' | 'signal' | 'discord';

/**
 * Channel binding for multi-agent config.
 * Each binding connects a channel instance to an agent.
 * Channel ID format: {type}:{name} (e.g., "telegram:work-dm")
 */
export interface AgentChannelBinding {
  type: ChannelType;
  name: string;  // Unique instance name within agent
  // Channel-specific config fields (token, botToken, dmPolicy, etc.)
  [key: string]: unknown;
}

/**
 * Agent entry for multi-agent config.
 */
export interface MultiAgentEntry {
  name: string;           // User-friendly agent name (e.g., "work-assistant")
  id?: string;            // Use existing Letta Code agent ID
  model?: string;         // Model to use (defaults to server default)
  channels: AgentChannelBinding[];
  features?: {
    cron?: boolean;
    heartbeat?: HeartbeatConfig;
    polling?: PollingConfig;
  };
}

/**
 * Heartbeat configuration
 */
export interface HeartbeatConfig {
  enabled: boolean;
  intervalMin?: number;
  prompt?: string;
  target?: string;  // Specific chat/user to send heartbeat to (format: "channel:chatId")
}

/**
 * Polling configuration (per-agent)
 */
export interface PollingConfig {
  enabled: boolean;
  intervalMs?: number;  // Polling interval in milliseconds (default: 60000)
  gmail?: {
    enabled: boolean;
    account: string;  // Gmail account to poll
  };
}

// ============================================================================
// Main Config Interface
// ============================================================================

export interface LettaBotConfig {
  // Server connection
  server: {
    // 'cloud' (api.letta.com) or 'selfhosted'
    mode: 'cloud' | 'selfhosted';
    // Only for selfhosted mode
    baseUrl?: string;
    // Only for cloud mode
    apiKey?: string;
  };

  // Agent configuration (legacy single-agent mode)
  agent?: {
    id?: string;
    name: string;
    model: string;
  };

  // Multi-agent configuration (new)
  agents?: MultiAgentEntry[];

  // BYOK providers (cloud mode only)
  providers?: ProviderConfig[];

  // Channel configurations (legacy single-agent mode, use agents[].channels for multi-agent)
  channels?: {
    telegram?: TelegramConfig;
    slack?: SlackConfig;
    whatsapp?: WhatsAppConfig;
    signal?: SignalConfig;
    discord?: DiscordConfig;
  };

  // Features (legacy single-agent mode, use agents[].features for multi-agent)
  features?: {
    cron?: boolean;
    heartbeat?: HeartbeatConfig;
  };

  // Integrations (Google Workspace, etc.)
  integrations?: {
    google?: GoogleConfig;
  };

  // Transcription (voice messages)
  transcription?: TranscriptionConfig;

  // Attachment handling
  attachments?: {
    maxMB?: number;
    maxAgeDays?: number;
  };
}

export interface TranscriptionConfig {
  provider: 'openai';  // Only OpenAI supported currently
  apiKey?: string;     // Falls back to OPENAI_API_KEY env var
  model?: string;      // Defaults to 'whisper-1'
}

export interface ProviderConfig {
  id: string;           // e.g., 'anthropic', 'openai'
  name: string;         // e.g., 'lc-anthropic'
  type: string;         // e.g., 'anthropic', 'openai'
  apiKey: string;
}

export interface TelegramConfig {
  enabled: boolean;
  token?: string;
  dmPolicy?: 'pairing' | 'allowlist' | 'open';
  allowedUsers?: string[];
}

export interface SlackConfig {
  enabled: boolean;
  appToken?: string;
  botToken?: string;
  allowedUsers?: string[];
}

export interface WhatsAppConfig {
  enabled: boolean;
  selfChat?: boolean;
  dmPolicy?: 'pairing' | 'allowlist' | 'open';
  allowedUsers?: string[];
  groupPolicy?: 'open' | 'disabled' | 'allowlist';
  groupAllowFrom?: string[];
  mentionPatterns?: string[];
  groups?: Record<string, { requireMention?: boolean }>;
}

export interface SignalConfig {
  enabled: boolean;
  phone?: string;
  selfChat?: boolean;
  dmPolicy?: 'pairing' | 'allowlist' | 'open';
  allowedUsers?: string[];
}

export interface DiscordConfig {
  enabled: boolean;
  token?: string;
  dmPolicy?: 'pairing' | 'allowlist' | 'open';
  allowedUsers?: string[];
}

export interface GoogleConfig {
  enabled: boolean;
  account?: string;
  services?: string[];  // e.g., ['gmail', 'calendar', 'drive', 'contacts', 'docs', 'sheets']
}

// Default config (legacy single-agent mode)
export const DEFAULT_CONFIG: Partial<LettaBotConfig> = {
  server: {
    mode: 'cloud',
  },
  agent: {
    name: 'LettaBot',
    model: 'zai/glm-4.7', // Free model default
  },
  channels: {},
};

/**
 * Check if config is multi-agent mode
 */
export function isMultiAgentConfig(config: LettaBotConfig): boolean {
  return Array.isArray(config.agents) && config.agents.length > 0;
}
