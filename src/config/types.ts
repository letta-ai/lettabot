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
    inlineImages?: boolean;   // Send images directly to the LLM (default: true). Set false to only send file paths.
    maxToolCalls?: number;  // Abort if agent calls this many tools in one turn (default: 100)
  };

  // Polling - system-level background checks (Gmail, etc.)
  polling?: PollingYamlConfig;

  // Integrations (Google Workspace, etc.)
  // NOTE: integrations.google is a legacy path for polling config.
  // Prefer the top-level `polling` section instead.
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

  // API server (health checks, CLI messaging)
  api?: {
    port?: number;       // Default: 8080 (or PORT env var)
    host?: string;       // Default: 127.0.0.1 (secure). Use '0.0.0.0' for Docker/Railway
    corsOrigin?: string; // CORS origin. Default: same-origin only
  };
}

export interface TranscriptionConfig {
  provider: 'openai';  // Only OpenAI supported currently
  apiKey?: string;     // Falls back to OPENAI_API_KEY env var
  model?: string;      // Defaults to 'whisper-1'
}

export interface PollingYamlConfig {
  enabled?: boolean;      // Master switch (default: auto-detected from sub-configs)
  intervalMs?: number;    // Polling interval in milliseconds (default: 60000)
  gmail?: {
    enabled?: boolean;    // Enable Gmail polling
    account?: string;     // Gmail account to poll (e.g., user@example.com)
  };
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
  dmPolicy?: 'pairing' | 'allowlist' | 'open';
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
  pollIntervalSec?: number;  // Polling interval in seconds (default: 60)
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
