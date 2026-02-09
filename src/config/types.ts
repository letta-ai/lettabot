/**
 * LettaBot Configuration Types
 * 
 * Two modes:
 * 1. Self-hosted: Uses baseUrl (e.g., http://localhost:8283), no API key
 * 2. Letta Cloud: Uses apiKey, optional BYOK providers
 */

/**
 * Configuration for a single agent in multi-agent mode.
 * Each agent has its own name, channels, and features.
 */
export interface AgentConfig {
  /** Agent name (used for display, agent creation, and store keying) */
  name: string;
  /** Use existing agent ID (skip creation) */
  id?: string;
  /** Model for initial agent creation */
  model?: string;
  /** Channels this agent connects to */
  channels: {
    telegram?: TelegramConfig;
    slack?: SlackConfig;
    whatsapp?: WhatsAppConfig;
    signal?: SignalConfig;
    discord?: DiscordConfig;
  };
  /** Features for this agent */
  features?: {
    cron?: boolean;
    heartbeat?: {
      enabled: boolean;
      intervalMin?: number;
    };
    maxToolCalls?: number;
  };
  /** Polling config */
  polling?: PollingYamlConfig;
  /** Integrations */
  integrations?: {
    google?: GoogleConfig;
  };
}

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

  // Multi-agent configuration
  agents?: AgentConfig[];

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

/**
 * Normalize config to multi-agent format.
 *
 * If the config uses legacy single-agent format (agent: + channels:),
 * it's converted to an agents[] array with one entry.
 * Channels with `enabled: false` are dropped during normalization.
 */
export function normalizeAgents(config: LettaBotConfig): AgentConfig[] {
  const normalizeChannels = (channels?: AgentConfig['channels']): AgentConfig['channels'] => {
    const normalized: AgentConfig['channels'] = {};
    if (!channels) return normalized;

    if (channels.telegram?.enabled !== false && channels.telegram?.token) {
      normalized.telegram = channels.telegram;
    }
    if (channels.slack?.enabled !== false && channels.slack?.botToken && channels.slack?.appToken) {
      normalized.slack = channels.slack;
    }
    if (channels.whatsapp?.enabled !== false && channels.whatsapp?.enabled) {
      normalized.whatsapp = channels.whatsapp;
    }
    if (channels.signal?.enabled !== false && channels.signal?.phone) {
      normalized.signal = channels.signal;
    }
    if (channels.discord?.enabled !== false && channels.discord?.token) {
      normalized.discord = channels.discord;
    }

    return normalized;
  };

  // Multi-agent mode: normalize channels for each configured agent
  if (config.agents && config.agents.length > 0) {
    return config.agents.map(agent => ({
      ...agent,
      channels: normalizeChannels(agent.channels),
    }));
  }

  // Legacy single-agent mode: normalize to agents[]
  const agentName = config.agent?.name || 'LettaBot';
  const model = config.agent?.model;
  const id = config.agent?.id;

  // Filter out disabled/misconfigured channels
  const channels = normalizeChannels(config.channels);

  return [{
    name: agentName,
    id,
    model,
    channels,
    features: config.features,
    polling: config.polling,
    integrations: config.integrations,
  }];
}
