/**
 * LettaBot Configuration Types
 * 
 * Two modes:
 * 1. Docker server: Uses baseUrl (e.g., http://localhost:8283), no API key
 * 2. Letta API: Uses apiKey, optional BYOK providers
 */

export type ServerMode = 'api' | 'docker' | 'cloud' | 'selfhosted';
export type CanonicalServerMode = 'api' | 'docker';

export function canonicalizeServerMode(mode?: ServerMode): CanonicalServerMode {
  return mode === 'docker' || mode === 'selfhosted' ? 'docker' : 'api';
}

export function isDockerServerMode(mode?: ServerMode): boolean {
  return canonicalizeServerMode(mode) === 'docker';
}

export function isApiServerMode(mode?: ServerMode): boolean {
  return canonicalizeServerMode(mode) === 'api';
}

export function serverModeLabel(mode?: ServerMode): string {
  return canonicalizeServerMode(mode);
}

/**
 * Configuration for a single agent in multi-agent mode.
 * Each agent has its own name, channels, and features.
 */
export interface AgentConfig {
  /** Agent name (used for display, agent creation, and store keying) */
  name: string;
  /** Use existing agent ID (skip creation) */
  id?: string;
  /** Display name prefixed to outbound messages (e.g. "💜 Signo") */
  displayName?: string;
  /** Model for initial agent creation */
  model?: string;
  /** Channels this agent connects to */
  channels: {
    telegram?: TelegramConfig;
    'telegram-mtproto'?: TelegramMTProtoConfig;
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
      skipRecentUserMin?: number; // Skip auto-heartbeats for N minutes after user message (0 disables)
      prompt?: string;       // Custom heartbeat prompt (replaces default body)
      promptFile?: string;   // Path to prompt file (re-read each tick for live editing)
      target?: string;       // Delivery target ("telegram:123", "slack:C123", etc.)
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
    // Canonical values: 'api' or 'docker'
    // Legacy aliases accepted for compatibility: 'cloud', 'selfhosted'
    mode: ServerMode;
    // Only for docker mode
    baseUrl?: string;
    // Only for api mode
    apiKey?: string;
    // API server config (port, host, CORS) — canonical location
    api?: {
      port?: number;       // Default: 8080 (or PORT env var)
      host?: string;       // Default: 127.0.0.1 (secure). Use '0.0.0.0' for Docker/Railway
      corsOrigin?: string; // CORS origin. Default: same-origin only
    };
  };

  // Multi-agent configuration
  agents?: AgentConfig[];

  // Agent configuration
  agent: {
    id?: string;
    name: string;
    displayName?: string;
    // model is configured on the Letta agent server-side, not in config
    // Kept as optional for backward compat (ignored if present in existing configs)
    model?: string;
  };

  // BYOK providers (api mode only)
  providers?: ProviderConfig[];

  // Channel configurations
  channels: {
    telegram?: TelegramConfig;
    'telegram-mtproto'?: TelegramMTProtoConfig;
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
      skipRecentUserMin?: number; // Skip auto-heartbeats for N minutes after user message (0 disables)
      prompt?: string;       // Custom heartbeat prompt (replaces default body)
      promptFile?: string;   // Path to prompt file (re-read each tick for live editing)
      target?: string;       // Delivery target ("telegram:123", "slack:C123", etc.)
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
  /** @deprecated Use server.api instead */
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
    accounts?: string[];  // Multiple Gmail accounts to poll
  };
}

export interface ProviderConfig {
  id: string;           // e.g., 'anthropic', 'openai'
  name: string;         // e.g., 'lc-anthropic'
  type: string;         // e.g., 'anthropic', 'openai'
  apiKey: string;
}

export type GroupMode = 'open' | 'listen' | 'mention-only' | 'disabled';

export interface GroupConfig {
  mode?: GroupMode;
  /** Only process group messages from these user IDs. Omit to allow all users. */
  allowedUsers?: string[];
  /**
   * @deprecated Use mode: "mention-only" (true) or "open" (false).
   */
  requireMention?: boolean;
}

export interface TelegramConfig {
  enabled: boolean;
  token?: string;
  dmPolicy?: 'pairing' | 'allowlist' | 'open';
  allowedUsers?: string[];
  groupDebounceSec?: number;      // Debounce interval in seconds (default: 5, 0 = immediate)
  groupPollIntervalMin?: number;  // @deprecated Use groupDebounceSec instead
  instantGroups?: string[];       // Group chat IDs that bypass batching
  listeningGroups?: string[];     // @deprecated Use groups.<id>.mode = "listen"
  mentionPatterns?: string[];     // Regex patterns for mention detection (e.g., ["@mybot"])
  groups?: Record<string, GroupConfig>;  // Per-group settings, "*" for defaults
}

export interface TelegramMTProtoConfig {
  enabled: boolean;
  phoneNumber?: string;          // E.164 format: +1234567890
  apiId?: number;                // From my.telegram.org
  apiHash?: string;              // From my.telegram.org
  databaseDirectory?: string;    // Default: ./data/telegram-mtproto
  dmPolicy?: 'pairing' | 'allowlist' | 'open';
  allowedUsers?: number[];       // Telegram user IDs
  groupPolicy?: 'mention' | 'reply' | 'both' | 'off';
  adminChatId?: number;          // Chat ID for pairing request notifications
}

export interface SlackConfig {
  enabled: boolean;
  appToken?: string;
  botToken?: string;
  dmPolicy?: 'pairing' | 'allowlist' | 'open';
  allowedUsers?: string[];
  groupDebounceSec?: number;      // Debounce interval in seconds (default: 5, 0 = immediate)
  groupPollIntervalMin?: number;  // @deprecated Use groupDebounceSec instead
  instantGroups?: string[];       // Channel IDs that bypass batching
  listeningGroups?: string[];     // @deprecated Use groups.<id>.mode = "listen"
  groups?: Record<string, GroupConfig>;  // Per-channel settings, "*" for defaults
}

export interface WhatsAppConfig {
  enabled: boolean;
  selfChat?: boolean;
  dmPolicy?: 'pairing' | 'allowlist' | 'open';
  allowedUsers?: string[];
  groupPolicy?: 'open' | 'disabled' | 'allowlist';
  groupAllowFrom?: string[];
  mentionPatterns?: string[];
  groups?: Record<string, GroupConfig>;
  groupDebounceSec?: number;      // Debounce interval in seconds (default: 5, 0 = immediate)
  groupPollIntervalMin?: number;  // @deprecated Use groupDebounceSec instead
  instantGroups?: string[];       // Group JIDs that bypass batching
  listeningGroups?: string[];     // @deprecated Use groups.<id>.mode = "listen"
}

export interface SignalConfig {
  enabled: boolean;
  phone?: string;
  selfChat?: boolean;
  dmPolicy?: 'pairing' | 'allowlist' | 'open';
  allowedUsers?: string[];
  // Group gating
  mentionPatterns?: string[];  // Regex patterns for mention detection (e.g., ["@bot"])
  groups?: Record<string, GroupConfig>;  // Per-group settings, "*" for defaults
  groupDebounceSec?: number;      // Debounce interval in seconds (default: 5, 0 = immediate)
  groupPollIntervalMin?: number;  // @deprecated Use groupDebounceSec instead
  instantGroups?: string[];       // Group IDs that bypass batching
  listeningGroups?: string[];     // @deprecated Use groups.<id>.mode = "listen"
}

export interface DiscordConfig {
  enabled: boolean;
  token?: string;
  dmPolicy?: 'pairing' | 'allowlist' | 'open';
  allowedUsers?: string[];
  groupDebounceSec?: number;      // Debounce interval in seconds (default: 5, 0 = immediate)
  groupPollIntervalMin?: number;  // @deprecated Use groupDebounceSec instead
  instantGroups?: string[];       // Guild/server IDs or channel IDs that bypass batching
  listeningGroups?: string[];     // @deprecated Use groups.<id>.mode = "listen"
  groups?: Record<string, GroupConfig>;  // Per-guild/channel settings, "*" for defaults
}

/**
 * Telegram MTProto (user account) configuration.
 * Uses TDLib for user account mode instead of Bot API.
 * Cannot be used simultaneously with TelegramConfig (bot mode).
 */
export interface TelegramMTProtoConfig {
  enabled: boolean;
  phoneNumber?: string;          // E.164 format: +1234567890
  apiId?: number;                // From my.telegram.org
  apiHash?: string;              // From my.telegram.org
  databaseDirectory?: string;    // Default: ./data/telegram-mtproto
  dmPolicy?: 'pairing' | 'allowlist' | 'open';
  allowedUsers?: number[];              // Telegram user IDs
  groupPolicy?: 'mention' | 'reply' | 'both' | 'off';
  adminChatId?: number;          // Chat ID for pairing request notifications
  groupDebounceSec?: number;     // Debounce interval in seconds (default: 5, 0 = immediate)
  instantGroups?: string[];      // Chat IDs that bypass batching
}

export interface GoogleAccountConfig {
  account: string;
  services?: string[];  // e.g., ['gmail', 'calendar', 'drive', 'contacts', 'docs', 'sheets']
}

export interface GoogleConfig {
  enabled: boolean;
  account?: string;
  accounts?: GoogleAccountConfig[];
  services?: string[];  // e.g., ['gmail', 'calendar', 'drive', 'contacts', 'docs', 'sheets']
  pollIntervalSec?: number;  // Polling interval in seconds (default: 60)
}

// Default config
export const DEFAULT_CONFIG: LettaBotConfig = {
  server: {
    mode: 'api',
  },
  agent: {
    name: 'LettaBot',
    // model is configured on the Letta agent server-side (via onboarding or `lettabot model set`)
  },
  channels: {},
};

type ChannelWithLegacyGroupFields = {
  groups?: Record<string, GroupConfig>;
  listeningGroups?: string[];
};

const warnedGroupConfigDeprecations = new Set<string>();

function warnGroupConfigDeprecation(path: string, detail: string): void {
  const key = `${path}:${detail}`;
  if (warnedGroupConfigDeprecations.has(key)) return;
  warnedGroupConfigDeprecations.add(key);
  console.warn(`[Config] WARNING: ${path} ${detail}`);
}

function normalizeLegacyGroupFields(
  channel: ChannelWithLegacyGroupFields | undefined,
  path: string,
): void {
  if (!channel) return;

  const hadOriginalGroups = !!(
    channel.groups &&
    typeof channel.groups === 'object' &&
    Object.keys(channel.groups).length > 0
  );

  const groups: Record<string, GroupConfig> = channel.groups && typeof channel.groups === 'object'
    ? { ...channel.groups }
    : {};
  const modeDerivedFromRequireMention = new Set<string>();

  let sawLegacyRequireMention = false;
  for (const [groupId, value] of Object.entries(groups)) {
    const group = value && typeof value === 'object' ? { ...value } : {};
    const hasLegacyRequireMention = typeof group.requireMention === 'boolean';
    if (hasLegacyRequireMention) {
      sawLegacyRequireMention = true;
    }
    if (!group.mode && hasLegacyRequireMention) {
      group.mode = group.requireMention ? 'mention-only' : 'open';
      modeDerivedFromRequireMention.add(groupId);
    }
    if ('requireMention' in group) {
      delete group.requireMention;
    }
    groups[groupId] = group;
  }
  if (sawLegacyRequireMention) {
    warnGroupConfigDeprecation(
      `${path}.groups.<id>.requireMention`,
      'is deprecated. Use groups.<id>.mode: "mention-only" | "open" | "listen".'
    );
  }

  const legacyListeningGroups = Array.isArray(channel.listeningGroups)
    ? channel.listeningGroups.map((id) => String(id).trim()).filter(Boolean)
    : [];

  if (legacyListeningGroups.length > 0) {
    warnGroupConfigDeprecation(
      `${path}.listeningGroups`,
      'is deprecated. Use groups.<id>.mode: "listen".'
    );
    for (const id of legacyListeningGroups) {
      const existing = groups[id] ? { ...groups[id] } : {};
      if (!existing.mode || modeDerivedFromRequireMention.has(id)) {
        existing.mode = 'listen';
      } else if (existing.mode !== 'listen') {
        warnGroupConfigDeprecation(
          `${path}.groups.${id}.mode`,
          `is "${existing.mode}" while ${path}.listeningGroups also includes "${id}". Keeping mode "${existing.mode}".`
        );
      }
      groups[id] = existing;
    }

    // Legacy listeningGroups never restricted other groups.
    // Add wildcard open when there was no explicit groups config.
    if (!hadOriginalGroups && !groups['*']) {
      groups['*'] = { mode: 'open' };
    }
  }

  channel.groups = Object.keys(groups).length > 0 ? groups : undefined;
  delete channel.listeningGroups;
}

/**
 * Normalize config to multi-agent format.
 *
 * If the config uses legacy single-agent format (agent: + channels:),
 * it's converted to an agents[] array with one entry.
 * Channels with `enabled: false` are dropped during normalization.
 */
export function normalizeAgents(config: LettaBotConfig): AgentConfig[] {
  const normalizeChannels = (channels?: AgentConfig['channels'], sourcePath = 'channels'): AgentConfig['channels'] => {
    const normalized: AgentConfig['channels'] = {};
    if (!channels) return normalized;

    if (channels.telegram?.enabled !== false && channels.telegram?.token) {
      const telegram = { ...channels.telegram };
      normalizeLegacyGroupFields(telegram, `${sourcePath}.telegram`);
      normalized.telegram = telegram;
    }
    // telegram-mtproto: check apiId as the key credential
    if (channels['telegram-mtproto']?.enabled !== false && channels['telegram-mtproto']?.apiId) {
      normalized['telegram-mtproto'] = channels['telegram-mtproto'];
    }
    if (channels.slack?.enabled !== false && channels.slack?.botToken && channels.slack?.appToken) {
      const slack = { ...channels.slack };
      normalizeLegacyGroupFields(slack, `${sourcePath}.slack`);
      normalized.slack = slack;
    }
    // WhatsApp has no credential to check (uses QR pairing), so just check enabled
    if (channels.whatsapp?.enabled) {
      const whatsapp = { ...channels.whatsapp };
      normalizeLegacyGroupFields(whatsapp, `${sourcePath}.whatsapp`);
      normalized.whatsapp = whatsapp;
    }
    if (channels.signal?.enabled !== false && channels.signal?.phone) {
      const signal = { ...channels.signal };
      normalizeLegacyGroupFields(signal, `${sourcePath}.signal`);
      normalized.signal = signal;
    }
    if (channels.discord?.enabled !== false && channels.discord?.token) {
      const discord = { ...channels.discord };
      normalizeLegacyGroupFields(discord, `${sourcePath}.discord`);
      normalized.discord = discord;
    }

    return normalized;
  };

  // Multi-agent mode: normalize channels for each configured agent
  if (config.agents && config.agents.length > 0) {
    return config.agents.map((agent, index) => ({
      ...agent,
      channels: normalizeChannels(agent.channels, `agents[${index}].channels`),
    }));
  }

  // Legacy single-agent mode: normalize to agents[]
  const envAgentName = process.env.LETTA_AGENT_NAME || process.env.AGENT_NAME;
  const agentName = envAgentName || config.agent?.name || 'LettaBot';
  const model = config.agent?.model;
  const id = config.agent?.id;

  // Filter out disabled/misconfigured channels
  const channels = normalizeChannels(config.channels, 'channels');

  // Env var fallback for container deploys without lettabot.yaml (e.g. Railway)
  // Helper: parse comma-separated env var into string array (or undefined)
  const parseList = (envVar?: string): string[] | undefined =>
    envVar ? envVar.split(',').map(s => s.trim()).filter(Boolean) : undefined;

  if (!channels.telegram && process.env.TELEGRAM_BOT_TOKEN) {
    channels.telegram = {
      enabled: true,
      token: process.env.TELEGRAM_BOT_TOKEN,
      dmPolicy: (process.env.TELEGRAM_DM_POLICY as 'pairing' | 'allowlist' | 'open') || 'pairing',
      allowedUsers: parseList(process.env.TELEGRAM_ALLOWED_USERS),
    };
  }
  // telegram-mtproto env var fallback (only if telegram bot not configured)
  if (!channels.telegram && !channels['telegram-mtproto'] && process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH && process.env.TELEGRAM_PHONE_NUMBER) {
    channels['telegram-mtproto'] = {
      enabled: true,
      apiId: parseInt(process.env.TELEGRAM_API_ID, 10),
      apiHash: process.env.TELEGRAM_API_HASH,
      phoneNumber: process.env.TELEGRAM_PHONE_NUMBER,
      databaseDirectory: process.env.TELEGRAM_MTPROTO_DB_DIR || './data/telegram-mtproto',
      dmPolicy: (process.env.TELEGRAM_DM_POLICY as 'pairing' | 'allowlist' | 'open') || 'pairing',
      allowedUsers: parseList(process.env.TELEGRAM_ALLOWED_USERS)?.map(s => parseInt(s, 10)).filter(n => !isNaN(n)),
      groupPolicy: (process.env.TELEGRAM_GROUP_POLICY as 'mention' | 'reply' | 'both' | 'off') || 'both',
      adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID ? parseInt(process.env.TELEGRAM_ADMIN_CHAT_ID, 10) : undefined,
    };
  }
  if (!channels.slack && process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    channels.slack = {
      enabled: true,
      botToken: process.env.SLACK_BOT_TOKEN,
      appToken: process.env.SLACK_APP_TOKEN,
      dmPolicy: (process.env.SLACK_DM_POLICY as 'pairing' | 'allowlist' | 'open') || 'pairing',
      allowedUsers: parseList(process.env.SLACK_ALLOWED_USERS),
    };
  }
  if (!channels.whatsapp && process.env.WHATSAPP_ENABLED === 'true') {
    channels.whatsapp = {
      enabled: true,
      selfChat: process.env.WHATSAPP_SELF_CHAT_MODE !== 'false',
      dmPolicy: (process.env.WHATSAPP_DM_POLICY as 'pairing' | 'allowlist' | 'open') || 'pairing',
      allowedUsers: parseList(process.env.WHATSAPP_ALLOWED_USERS),
    };
  }
  if (!channels.signal && process.env.SIGNAL_PHONE_NUMBER) {
    channels.signal = {
      enabled: true,
      phone: process.env.SIGNAL_PHONE_NUMBER,
      selfChat: process.env.SIGNAL_SELF_CHAT_MODE !== 'false',
      dmPolicy: (process.env.SIGNAL_DM_POLICY as 'pairing' | 'allowlist' | 'open') || 'pairing',
      allowedUsers: parseList(process.env.SIGNAL_ALLOWED_USERS),
    };
  }
  if (!channels.discord && process.env.DISCORD_BOT_TOKEN) {
    channels.discord = {
      enabled: true,
      token: process.env.DISCORD_BOT_TOKEN,
      dmPolicy: (process.env.DISCORD_DM_POLICY as 'pairing' | 'allowlist' | 'open') || 'pairing',
      allowedUsers: parseList(process.env.DISCORD_ALLOWED_USERS),
    };
  }

  return [{
    name: agentName,
    id,
    displayName: config.agent?.displayName,
    model,
    channels,
    features: config.features,
    polling: config.polling,
    integrations: config.integrations,
  }];
}
