/**
 * LettaBot Configuration Types
 * 
 * Two modes:
 * 1. Self-hosted: Uses baseUrl (e.g., http://localhost:8283), no API key
 * 2. Letta Cloud: Uses apiKey, optional BYOK providers
 */

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

  // Agent configuration
  agent: {
    id?: string;
    name: string;
    model: string;
  };

  // BYOK providers (cloud mode only)
  providers?: ProviderConfig[];

  // Channel configurations
  channels: {
    telegram?: TelegramConfig;
    slack?: SlackConfig;
    whatsapp?: WhatsAppConfig;
    signal?: SignalConfig;
    discord?: DiscordConfig;
  };

  // Features
  features?: {
    cron?: boolean;
    heartbeat?: {
      enabled: boolean;
      intervalMin?: number;
    };
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
  groupPollIntervalMin?: number;  // Batch interval in minutes (default: 10, 0 = immediate)
  instantGroups?: string[];       // Group chat IDs that bypass batching
}

export interface SlackConfig {
  enabled: boolean;
  appToken?: string;
  botToken?: string;
  allowedUsers?: string[];
  groupPollIntervalMin?: number;  // Batch interval in minutes (default: 10, 0 = immediate)
  instantGroups?: string[];       // Channel IDs that bypass batching
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
  groupPollIntervalMin?: number;  // Batch interval in minutes (default: 10, 0 = immediate)
  instantGroups?: string[];       // Group JIDs that bypass batching
}

export interface SignalConfig {
  enabled: boolean;
  phone?: string;
  selfChat?: boolean;
  dmPolicy?: 'pairing' | 'allowlist' | 'open';
  allowedUsers?: string[];
  // Group gating
  mentionPatterns?: string[];  // Regex patterns for mention detection (e.g., ["@bot"])
  groups?: Record<string, { requireMention?: boolean }>;  // Per-group settings, "*" for defaults
  groupPollIntervalMin?: number;  // Batch interval in minutes (default: 10, 0 = immediate)
  instantGroups?: string[];       // Group IDs that bypass batching
}

export interface DiscordConfig {
  enabled: boolean;
  token?: string;
  dmPolicy?: 'pairing' | 'allowlist' | 'open';
  allowedUsers?: string[];
  groupPollIntervalMin?: number;  // Batch interval in minutes (default: 10, 0 = immediate)
  instantGroups?: string[];       // Guild/server IDs or channel IDs that bypass batching
}

export interface GoogleConfig {
  enabled: boolean;
  account?: string;
  services?: string[];  // e.g., ['gmail', 'calendar', 'drive', 'contacts', 'docs', 'sheets']
}

// Default config
export const DEFAULT_CONFIG: LettaBotConfig = {
  server: {
    mode: 'cloud',
  },
  agent: {
    name: 'LettaBot',
    model: 'zai/glm-4.7', // Free model default
  },
  channels: {},
};
