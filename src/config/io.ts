/**
 * LettaBot Configuration I/O
 * 
 * Config file location: ~/.lettabot/config.yaml (or ./lettabot.yaml in project)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import type { LettaBotConfig, ProviderConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

// Config file locations (checked in order)
const CONFIG_PATHS = [
  resolve(process.cwd(), 'lettabot.yaml'),           // Project-local
  resolve(process.cwd(), 'lettabot.yml'),            // Project-local alt
  join(homedir(), '.lettabot', 'config.yaml'),       // User global
  join(homedir(), '.lettabot', 'config.yml'),        // User global alt
];

const DEFAULT_CONFIG_PATH = join(homedir(), '.lettabot', 'config.yaml');

/**
 * Find the config file path (first existing, or default)
 * 
 * Priority:
 * 1. LETTABOT_CONFIG env var (explicit override)
 * 2. ./lettabot.yaml (project-local)
 * 3. ./lettabot.yml (project-local alt)
 * 4. ~/.lettabot/config.yaml (user global)
 * 5. ~/.lettabot/config.yml (user global alt)
 */
export function resolveConfigPath(): string {
  // Environment variable takes priority
  if (process.env.LETTABOT_CONFIG) {
    return resolve(process.env.LETTABOT_CONFIG);
  }
  
  for (const p of CONFIG_PATHS) {
    if (existsSync(p)) {
      return p;
    }
  }
  return DEFAULT_CONFIG_PATH;
}

/**
 * Load config from YAML file
 */
export function loadConfig(): LettaBotConfig {
  const configPath = resolveConfigPath();
  
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  
  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = YAML.parse(content) as Partial<LettaBotConfig>;

    // Fix instantGroups: YAML parses large numeric IDs (e.g. Discord snowflakes)
    // as JavaScript numbers, losing precision for values > Number.MAX_SAFE_INTEGER.
    // Re-extract from document AST to preserve the original string representation.
    fixInstantGroupIds(content, parsed);

    // Merge with defaults
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      server: { ...DEFAULT_CONFIG.server, ...parsed.server },
      agent: { ...DEFAULT_CONFIG.agent, ...parsed.agent },
      channels: { ...DEFAULT_CONFIG.channels, ...parsed.channels },
    };
  } catch (err) {
    console.error(`[Config] Failed to load ${configPath}:`, err);
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Save config to YAML file
 */
export function saveConfig(config: LettaBotConfig, path?: string): void {
  const configPath = path || resolveConfigPath();
  
  // Ensure directory exists
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  // Convert to YAML with comments
  const content = YAML.stringify(config, {
    indent: 2,
    lineWidth: 0, // Don't wrap lines
  });
  
  writeFileSync(configPath, content, 'utf-8');
  console.log(`[Config] Saved to ${configPath}`);
}

/**
 * Get environment variables from config (for backwards compatibility)
 */
export function configToEnv(config: LettaBotConfig): Record<string, string> {
  const env: Record<string, string> = {};
  
  // Server
  if (config.server.mode === 'selfhosted' && config.server.baseUrl) {
    env.LETTA_BASE_URL = config.server.baseUrl;
  }
  if (config.server.apiKey) {
    env.LETTA_API_KEY = config.server.apiKey;
  }
  
  // Agent
  if (config.agent.id) {
    env.LETTA_AGENT_ID = config.agent.id;
  }
  if (config.agent.name) {
    env.AGENT_NAME = config.agent.name;
  }
  // Note: agent.model is intentionally NOT mapped to env.
  // The model is configured on the Letta agent server-side.
  
  // Channels
  if (config.channels.telegram?.token) {
    env.TELEGRAM_BOT_TOKEN = config.channels.telegram.token;
    if (config.channels.telegram.dmPolicy) {
      env.TELEGRAM_DM_POLICY = config.channels.telegram.dmPolicy;
    }
  }
  if (config.channels.slack?.appToken) {
    env.SLACK_APP_TOKEN = config.channels.slack.appToken;
  }
  if (config.channels.slack?.botToken) {
    env.SLACK_BOT_TOKEN = config.channels.slack.botToken;
  }
  if (config.channels.slack?.dmPolicy) {
    env.SLACK_DM_POLICY = config.channels.slack.dmPolicy;
  }
  if (config.channels.slack?.groupPollIntervalMin !== undefined) {
    env.SLACK_GROUP_POLL_INTERVAL_MIN = String(config.channels.slack.groupPollIntervalMin);
  }
  if (config.channels.slack?.instantGroups?.length) {
    env.SLACK_INSTANT_GROUPS = config.channels.slack.instantGroups.join(',');
  }
  if (config.channels.whatsapp?.enabled) {
    env.WHATSAPP_ENABLED = 'true';
    if (config.channels.whatsapp.selfChat) {
      env.WHATSAPP_SELF_CHAT_MODE = 'true';
    } else {
      env.WHATSAPP_SELF_CHAT_MODE = 'false';
    }
  }
  if (config.channels.whatsapp?.groupPollIntervalMin !== undefined) {
    env.WHATSAPP_GROUP_POLL_INTERVAL_MIN = String(config.channels.whatsapp.groupPollIntervalMin);
  }
  if (config.channels.whatsapp?.instantGroups?.length) {
    env.WHATSAPP_INSTANT_GROUPS = config.channels.whatsapp.instantGroups.join(',');
  }
  if (config.channels.signal?.phone) {
    env.SIGNAL_PHONE_NUMBER = config.channels.signal.phone;
    // Signal selfChat defaults to true, so only set env if explicitly false
    if (config.channels.signal.selfChat === false) {
      env.SIGNAL_SELF_CHAT_MODE = 'false';
    }
  }
  if (config.channels.signal?.groupPollIntervalMin !== undefined) {
    env.SIGNAL_GROUP_POLL_INTERVAL_MIN = String(config.channels.signal.groupPollIntervalMin);
  }
  if (config.channels.signal?.instantGroups?.length) {
    env.SIGNAL_INSTANT_GROUPS = config.channels.signal.instantGroups.join(',');
  }
  if (config.channels.telegram?.groupPollIntervalMin !== undefined) {
    env.TELEGRAM_GROUP_POLL_INTERVAL_MIN = String(config.channels.telegram.groupPollIntervalMin);
  }
  if (config.channels.telegram?.instantGroups?.length) {
    env.TELEGRAM_INSTANT_GROUPS = config.channels.telegram.instantGroups.join(',');
  }
  if (config.channels.discord?.token) {
    env.DISCORD_BOT_TOKEN = config.channels.discord.token;
    if (config.channels.discord.dmPolicy) {
      env.DISCORD_DM_POLICY = config.channels.discord.dmPolicy;
    }
    if (config.channels.discord.allowedUsers?.length) {
      env.DISCORD_ALLOWED_USERS = config.channels.discord.allowedUsers.join(',');
    }
  }
  if (config.channels.discord?.groupPollIntervalMin !== undefined) {
    env.DISCORD_GROUP_POLL_INTERVAL_MIN = String(config.channels.discord.groupPollIntervalMin);
  }
  if (config.channels.discord?.instantGroups?.length) {
    env.DISCORD_INSTANT_GROUPS = config.channels.discord.instantGroups.join(',');
  }
  
  // Features
  if (config.features?.cron) {
    env.CRON_ENABLED = 'true';
  }
  if (config.features?.heartbeat?.enabled) {
    env.HEARTBEAT_INTERVAL_MIN = String(config.features.heartbeat.intervalMin || 30);
  }
  if (config.features?.inlineImages === false) {
    env.INLINE_IMAGES = 'false';
  }
  if (config.features?.maxToolCalls !== undefined) {
    env.MAX_TOOL_CALLS = String(config.features.maxToolCalls);
  }

  // Polling - top-level polling config (preferred)
  if (config.polling?.gmail?.enabled && config.polling.gmail.account) {
    env.GMAIL_ACCOUNT = config.polling.gmail.account;
  }
  if (config.polling?.intervalMs) {
    env.POLLING_INTERVAL_MS = String(config.polling.intervalMs);
  }

  // Integrations - Google (legacy path for Gmail polling, lower priority)
  if (!env.GMAIL_ACCOUNT && config.integrations?.google?.enabled && config.integrations.google.account) {
    env.GMAIL_ACCOUNT = config.integrations.google.account;
  }
  if (!env.POLLING_INTERVAL_MS && config.integrations?.google?.pollIntervalSec) {
    env.POLLING_INTERVAL_MS = String(config.integrations.google.pollIntervalSec * 1000);
  }

  if (config.attachments?.maxMB !== undefined) {
    env.ATTACHMENTS_MAX_MB = String(config.attachments.maxMB);
  }
  if (config.attachments?.maxAgeDays !== undefined) {
    env.ATTACHMENTS_MAX_AGE_DAYS = String(config.attachments.maxAgeDays);
  }

  // API server
  if (config.api?.port !== undefined) {
    env.PORT = String(config.api.port);
  }
  if (config.api?.host) {
    env.API_HOST = config.api.host;
  }
  if (config.api?.corsOrigin) {
    env.API_CORS_ORIGIN = config.api.corsOrigin;
  }
  
  return env;
}

/**
 * Apply config to process.env (YAML config takes priority over .env)
 */
export function applyConfigToEnv(config: LettaBotConfig): void {
  const env = configToEnv(config);
  for (const [key, value] of Object.entries(env)) {
    // YAML config always takes priority
    process.env[key] = value;
  }
}

/**
 * Create BYOK providers on Letta Cloud
 */
export async function syncProviders(config: LettaBotConfig): Promise<void> {
  if (config.server.mode !== 'cloud' || !config.server.apiKey) {
    return;
  }
  
  if (!config.providers || config.providers.length === 0) {
    return;
  }
  
  const apiKey = config.server.apiKey;
  const baseUrl = 'https://api.letta.com';
  
  // List existing providers
  const listResponse = await fetch(`${baseUrl}/v1/providers`, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
  });
  
  const existingProviders = listResponse.ok 
    ? await listResponse.json() as Array<{ id: string; name: string }>
    : [];
  
  // Create or update each provider
  for (const provider of config.providers) {
    const existing = existingProviders.find(p => p.name === provider.name);
    
    try {
      if (existing) {
        // Update existing
        await fetch(`${baseUrl}/v1/providers/${existing.id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ api_key: provider.apiKey }),
        });
        console.log(`[Config] Updated provider: ${provider.name}`);
      } else {
        // Create new
        await fetch(`${baseUrl}/v1/providers`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            name: provider.name,
            provider_type: provider.type,
            api_key: provider.apiKey,
          }),
        });
        console.log(`[Config] Created provider: ${provider.name}`);
      }
    } catch (err) {
      console.error(`[Config] Failed to sync provider ${provider.name}:`, err);
    }
  }
}

/**
 * Fix instantGroups arrays that may contain large numeric IDs parsed by YAML.
 * Discord snowflake IDs exceed Number.MAX_SAFE_INTEGER, so YAML parses them
 * as lossy JavaScript numbers. We re-read from the document AST to get the
 * original string representation.
 */
function fixInstantGroupIds(yamlContent: string, parsed: Partial<LettaBotConfig>): void {
  if (!parsed.channels) return;

  try {
    const doc = YAML.parseDocument(yamlContent);
    const channels = ['telegram', 'slack', 'whatsapp', 'signal', 'discord'] as const;

    for (const ch of channels) {
      const seq = doc.getIn(['channels', ch, 'instantGroups'], true);
      if (YAML.isSeq(seq)) {
        const fixed = seq.items.map((item: unknown) => {
          if (YAML.isScalar(item)) {
            // For numbers, use the original source text to avoid precision loss
            if (typeof item.value === 'number' && item.source) {
              return item.source;
            }
            return String(item.value);
          }
          return String(item);
        });
        const cfg = parsed.channels[ch];
        if (cfg) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (cfg as any).instantGroups = fixed;
        }
      }
    }
  } catch {
    // Fallback: just ensure entries are strings (won't fix precision, but safe)
    const channels = ['telegram', 'slack', 'whatsapp', 'signal', 'discord'] as const;
    for (const ch of channels) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cfg = parsed.channels?.[ch] as any;
      if (cfg && Array.isArray(cfg.instantGroups)) {
        cfg.instantGroups = cfg.instantGroups.map((v: unknown) => String(v));
      }
    }
  }
}
