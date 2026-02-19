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
import { DEFAULT_CONFIG, canonicalizeServerMode, isApiServerMode, isDockerServerMode } from './types.js';
import { LETTA_API_URL } from '../auth/oauth.js';

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
 * Whether the last loadConfig() call failed to parse the config file.
 * Used to avoid misleading "Loaded from" messages when the file exists but has syntax errors.
 */
let _lastLoadFailed = false;
export function didLoadFail(): boolean { return _lastLoadFailed; }

function hasObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseAndNormalizeConfig(content: string): LettaBotConfig {
  const parsed = YAML.parse(content) as Partial<LettaBotConfig>;

  // Fix instantGroups: YAML parses large numeric IDs (e.g. Discord snowflakes)
  // as JavaScript numbers, losing precision for values > Number.MAX_SAFE_INTEGER.
  // Re-extract from document AST to preserve the original string representation.
  fixLargeGroupIds(content, parsed);

  // Reject ambiguous API server configuration. During migration from top-level
  // `api` to `server.api`, having both can silently drop fields.
  if (hasObject(parsed.api) && hasObject(parsed.server) && hasObject(parsed.server.api)) {
    throw new Error(
      'Conflicting API config: both top-level `api` and `server.api` are set. Remove top-level `api` and keep only `server.api`.'
    );
  }

  // Merge with defaults and canonicalize server mode.
  const merged = {
    ...DEFAULT_CONFIG,
    ...parsed,
    server: { ...DEFAULT_CONFIG.server, ...parsed.server },
    agent: { ...DEFAULT_CONFIG.agent, ...parsed.agent },
    channels: { ...DEFAULT_CONFIG.channels, ...parsed.channels },
  };

  const config = {
    ...merged,
    server: {
      ...merged.server,
      mode: canonicalizeServerMode(merged.server.mode),
    },
  };

  // Deprecation warning: top-level api should be moved under server
  if (config.api && !config.server.api) {
    console.warn('[Config] WARNING: Top-level `api:` is deprecated. Move it under `server:`.');
  }

  return config;
}

/**
 * Load config from YAML file
 */
export function loadConfig(): LettaBotConfig {
  _lastLoadFailed = false;
  const configPath = resolveConfigPath();
  
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  
  try {
    const content = readFileSync(configPath, 'utf-8');
    return parseAndNormalizeConfig(content);
  } catch (err) {
    _lastLoadFailed = true;
    console.error(`[Config] Failed to load ${configPath}:`, err);
    console.warn('[Config] Using default configuration. Check your YAML syntax and field locations.');
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Strict config loader. Throws on invalid YAML/schema instead of silently
 * falling back to defaults.
 */
export function loadConfigStrict(): LettaBotConfig {
  _lastLoadFailed = false;
  const configPath = resolveConfigPath();

  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    return parseAndNormalizeConfig(content);
  } catch (err) {
    _lastLoadFailed = true;
    throw err;
  }
}

/**
 * Save config to YAML file
 */
export function saveConfig(config: Partial<LettaBotConfig> & Pick<LettaBotConfig, 'server'>, path?: string): void {
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
  if (isDockerServerMode(config.server.mode) && config.server.baseUrl) {
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
  // Telegram MTProto (user account mode)
  const mtproto = config.channels['telegram-mtproto'];
  if (mtproto?.enabled && mtproto.phoneNumber) {
    env.TELEGRAM_MTPROTO_PHONE = mtproto.phoneNumber;
    if (mtproto.apiId) {
      env.TELEGRAM_MTPROTO_API_ID = String(mtproto.apiId);
    }
    if (mtproto.apiHash) {
      env.TELEGRAM_MTPROTO_API_HASH = mtproto.apiHash;
    }
    if (mtproto.databaseDirectory) {
      env.TELEGRAM_MTPROTO_DB_DIR = mtproto.databaseDirectory;
    }
    if (mtproto.dmPolicy) {
      env.TELEGRAM_MTPROTO_DM_POLICY = mtproto.dmPolicy;
    }
    if (mtproto.allowedUsers?.length) {
      env.TELEGRAM_MTPROTO_ALLOWED_USERS = mtproto.allowedUsers.join(',');
    }
    if (mtproto.groupPolicy) {
      env.TELEGRAM_MTPROTO_GROUP_POLICY = mtproto.groupPolicy;
    }
    if (mtproto.adminChatId) {
      env.TELEGRAM_MTPROTO_ADMIN_CHAT_ID = String(mtproto.adminChatId);
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
  if (config.channels.slack?.listeningGroups?.length) {
    env.SLACK_LISTENING_GROUPS = config.channels.slack.listeningGroups.join(',');
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
  if (config.channels.whatsapp?.listeningGroups?.length) {
    env.WHATSAPP_LISTENING_GROUPS = config.channels.whatsapp.listeningGroups.join(',');
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
  if (config.channels.signal?.listeningGroups?.length) {
    env.SIGNAL_LISTENING_GROUPS = config.channels.signal.listeningGroups.join(',');
  }
  if (config.channels.telegram?.groupPollIntervalMin !== undefined) {
    env.TELEGRAM_GROUP_POLL_INTERVAL_MIN = String(config.channels.telegram.groupPollIntervalMin);
  }
  if (config.channels.telegram?.instantGroups?.length) {
    env.TELEGRAM_INSTANT_GROUPS = config.channels.telegram.instantGroups.join(',');
  }
  if (config.channels.telegram?.listeningGroups?.length) {
    env.TELEGRAM_LISTENING_GROUPS = config.channels.telegram.listeningGroups.join(',');
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
  if (config.channels.discord?.listeningGroups?.length) {
    env.DISCORD_LISTENING_GROUPS = config.channels.discord.listeningGroups.join(',');
  }

  // Features
  if (config.features?.cron) {
    env.CRON_ENABLED = 'true';
  }
  if (config.features?.heartbeat?.enabled) {
    env.HEARTBEAT_INTERVAL_MIN = String(config.features.heartbeat.intervalMin || 30);
    if (config.features.heartbeat.skipRecentUserMin !== undefined) {
      env.HEARTBEAT_SKIP_RECENT_USER_MIN = String(config.features.heartbeat.skipRecentUserMin);
    }
  }
  if (config.features?.inlineImages === false) {
    env.INLINE_IMAGES = 'false';
  }
  if (config.features?.maxToolCalls !== undefined) {
    env.MAX_TOOL_CALLS = String(config.features.maxToolCalls);
  }

  // Polling - top-level polling config (preferred)
  if (config.polling?.gmail?.enabled) {
    const accounts = config.polling.gmail.accounts !== undefined
      ? config.polling.gmail.accounts
      : (config.polling.gmail.account ? [config.polling.gmail.account] : []);
    if (accounts.length > 0) {
      env.GMAIL_ACCOUNT = accounts.join(',');
    }
  }
  if (config.polling?.intervalMs) {
    env.POLLING_INTERVAL_MS = String(config.polling.intervalMs);
  }

  // Integrations - Google (legacy path for Gmail polling, lower priority)
  if (!env.GMAIL_ACCOUNT && config.integrations?.google?.enabled) {
    const legacyAccounts = config.integrations.google.accounts
      ? config.integrations.google.accounts.map(a => a.account)
      : (config.integrations.google.account ? [config.integrations.google.account] : []);
    if (legacyAccounts.length > 0) {
      env.GMAIL_ACCOUNT = legacyAccounts.join(',');
    }
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

  // API server (server.api is canonical, top-level api is deprecated fallback)
  const apiConfig = config.server.api ?? config.api;
  if (apiConfig?.port !== undefined) {
    env.PORT = String(apiConfig.port);
  }
  if (apiConfig?.host) {
    env.API_HOST = apiConfig.host;
  }
  if (apiConfig?.corsOrigin) {
    env.API_CORS_ORIGIN = apiConfig.corsOrigin;
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
 * Create BYOK providers on Letta API
 */
export async function syncProviders(config: Partial<LettaBotConfig> & Pick<LettaBotConfig, 'server'>): Promise<void> {
  if (!isApiServerMode(config.server.mode) || !config.server.apiKey) {
    return;
  }
  
  if (!config.providers || config.providers.length === 0) {
    return;
  }
  
  const apiKey = config.server.apiKey;
  const baseUrl = LETTA_API_URL;
  
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
 * Fix group identifiers that may contain large numeric IDs parsed by YAML.
 * Discord snowflake IDs exceed Number.MAX_SAFE_INTEGER, so YAML parses them
 * as lossy JavaScript numbers. We re-read from the document AST to preserve
 * the original source text for:
 * - instantGroups/listeningGroups arrays
 * - groups map keys (new group mode config)
 */
function fixLargeGroupIds(yamlContent: string, parsed: Partial<LettaBotConfig>): void {
  if (!parsed.channels) return;

  const channels = ['telegram', 'slack', 'whatsapp', 'signal', 'discord'] as const;
  const groupFields = ['instantGroups', 'listeningGroups'] as const;

  try {
    const doc = YAML.parseDocument(yamlContent);

    for (const ch of channels) {
      for (const field of groupFields) {
        const seq = doc.getIn(['channels', ch, field], true);
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
            (cfg as any)[field] = fixed;
          }
        }
      }

      // Also fix groups map keys (e.g. discord snowflake IDs)
      const groupsNode = doc.getIn(['channels', ch, 'groups'], true);
      if (YAML.isMap(groupsNode)) {
        const fixedGroups: Record<string, unknown> = {};
        for (const pair of groupsNode.items) {
          const keyNode = (pair as { key?: unknown }).key;
          const valueNode = (pair as { value?: unknown }).value;

          let groupKey: string;
          if (YAML.isScalar(keyNode)) {
            if (typeof keyNode.value === 'number' && keyNode.source) {
              groupKey = keyNode.source;
            } else {
              groupKey = String(keyNode.value);
            }
          } else {
            groupKey = String(keyNode);
          }

          if (YAML.isMap(valueNode)) {
            const groupConfig: Record<string, unknown> = {};
            for (const settingPair of valueNode.items) {
              const settingKeyNode = (settingPair as { key?: unknown }).key;
              const settingValueNode = (settingPair as { value?: unknown }).value;
              const settingKey = YAML.isScalar(settingKeyNode)
                ? String(settingKeyNode.value)
                : String(settingKeyNode);
              if (YAML.isScalar(settingValueNode)) {
                groupConfig[settingKey] = settingValueNode.value;
              } else {
                groupConfig[settingKey] = settingValueNode as unknown;
              }
            }
            fixedGroups[groupKey] = groupConfig;
          } else if (YAML.isScalar(valueNode)) {
            fixedGroups[groupKey] = valueNode.value;
          } else {
            fixedGroups[groupKey] = valueNode as unknown;
          }
        }
        const cfg = parsed.channels[ch];
        if (cfg) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (cfg as any).groups = fixedGroups;
        }
      }
    }
  } catch {
    // Fallback: just ensure entries are strings (won't fix precision, but safe)
    for (const ch of channels) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cfg = parsed.channels?.[ch] as any;
      for (const field of groupFields) {
        if (cfg && Array.isArray(cfg[field])) {
          cfg[field] = cfg[field].map((v: unknown) => String(v));
        }
      }
      if (cfg && cfg.groups && typeof cfg.groups === 'object') {
        const fixedGroups: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(cfg.groups as Record<string, unknown>)) {
          fixedGroups[String(key)] = value;
        }
        cfg.groups = fixedGroups;
      }
    }
  }
}
