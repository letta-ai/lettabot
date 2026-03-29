/**
 * LettaBot Configuration I/O
 * 
 * Config sources (checked in priority order):
 * 1. LETTABOT_CONFIG_YAML env var (inline YAML or base64-encoded YAML)
 * 2. LETTABOT_CONFIG env var (file path)
 * 3. ./lettabot.yaml or ./lettabot.yml (project-local)
 * 4. ./agents.yml or ./agents.yaml (fleet config from lettactl)
 * 5. ~/.lettabot/config.yaml or ~/.lettabot/config.yml (user global)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import type { LettaBotConfig, ProviderConfig } from './types.js';
import { DEFAULT_CONFIG, canonicalizeServerMode, isApiServerMode, isDockerServerMode } from './types.js';
import { isFleetConfig, fleetConfigToLettaBotConfig, setLoadedFromFleetConfig } from './fleet-adapter.js';
import { LETTA_API_URL } from '../auth/oauth.js';

import { createLogger } from '../logger.js';

const log = createLogger('Config');

function getInlineConfigEnvValue(): string | undefined {
  const raw = process.env.LETTABOT_CONFIG_YAML;
  if (raw === undefined) return undefined;
  return raw.trim().length > 0 ? raw : undefined;
}

// Config file locations (checked in order)
function getConfigPaths(): string[] {
  return [
    resolve(process.cwd(), 'lettabot.yaml'),           // Project-local
    resolve(process.cwd(), 'lettabot.yml'),            // Project-local alt
    resolve(process.cwd(), 'agents.yml'),              // Fleet config
    resolve(process.cwd(), 'agents.yaml'),             // Fleet config alt
    join(homedir(), '.lettabot', 'config.yaml'),       // User global
    join(homedir(), '.lettabot', 'config.yml'),        // User global alt
  ];
}

const DEFAULT_CONFIG_PATH = join(homedir(), '.lettabot', 'config.yaml');

/**
 * Whether inline config is available via LETTABOT_CONFIG_YAML env var.
 * When set, this takes priority over all file-based config sources.
 */
export function hasInlineConfig(): boolean {
  return getInlineConfigEnvValue() !== undefined;
}

/**
 * Decode a value that may be raw YAML or base64-encoded YAML.
 * Detection strategy:
 * 1) Treat values that parse as YAML objects as raw YAML.
 * 2) Otherwise, require strict base64 and decode to YAML object.
 */
export function decodeYamlOrBase64(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('LETTABOT_CONFIG_YAML is empty');
  }

  // Prefer raw YAML when it parses successfully.
  try {
    const parsed = YAML.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return value;
    }
  } catch {
    // Fall through to base64 decoding.
  }

  const normalized = trimmed.replace(/\s+/g, '');
  const base64Standard = normalized.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64Standard)) {
    throw new Error('LETTABOT_CONFIG_YAML must be raw YAML or base64-encoded YAML');
  }

  const normalizedNoPad = base64Standard.replace(/=+$/, '');
  if (normalizedNoPad.length === 0 || normalizedNoPad.length % 4 === 1) {
    throw new Error('LETTABOT_CONFIG_YAML must be raw YAML or base64-encoded YAML');
  }

  const padded = normalizedNoPad + '='.repeat((4 - (normalizedNoPad.length % 4)) % 4);

  const decoded = Buffer.from(padded, 'base64').toString('utf-8');
  const roundTrip = Buffer.from(decoded, 'utf-8').toString('base64').replace(/=+$/, '');
  if (roundTrip !== normalizedNoPad) {
    throw new Error('LETTABOT_CONFIG_YAML is not valid base64');
  }

  try {
    const parsed = YAML.parse(decoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Decoded YAML must be an object');
    }
  } catch {
    throw new Error('LETTABOT_CONFIG_YAML decoded from base64 but is not valid YAML');
  }

  return decoded;
}

/**
 * Decode inline config from LETTABOT_CONFIG_YAML env var.
 */
function decodeInlineConfig(): string {
  const value = getInlineConfigEnvValue();
  if (!value) {
    throw new Error('LETTABOT_CONFIG_YAML is empty');
  }
  return decodeYamlOrBase64(value);
}

/**
 * Human-readable label for where config was loaded from.
 */
export function configSourceLabel(): string {
  if (hasInlineConfig()) return 'LETTABOT_CONFIG_YAML';
  const path = resolveConfigPath();
  return existsSync(path) ? path : 'defaults + environment variables';
}

/**
 * Encode a YAML config file as a base64 string suitable for LETTABOT_CONFIG_YAML.
 */
export function encodeConfigForEnv(yamlContent: string): string {
  return Buffer.from(yamlContent, 'utf-8').toString('base64');
}

/**
 * Find the config file path (first existing, or default).
 * Note: when LETTABOT_CONFIG_YAML is set, file-based config is bypassed
 * entirely -- use hasInlineConfig() to check.
 * 
 * Priority:
 * 1. LETTABOT_CONFIG env var (explicit override)
 * 2. ./lettabot.yaml (project-local)
 * 3. ./lettabot.yml (project-local alt)
 * 4. ./agents.yml (fleet config from lettactl)
 * 5. ./agents.yaml (fleet config alt)
 * 6. ~/.lettabot/config.yaml (user global)
 * 7. ~/.lettabot/config.yml (user global alt)
 */
export function resolveConfigPath(): string {
  // Environment variable takes priority
  if (process.env.LETTABOT_CONFIG) {
    return resolve(process.env.LETTABOT_CONFIG);
  }
  
  for (const p of getConfigPaths()) {
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
  const parsed = YAML.parse(content);

  // Fleet config detection: agents.yml from lettactl with llm_config/system_prompt
  if (isFleetConfig(parsed)) {
    const parsedFleet = parsed as Record<string, unknown>;

    // Preserve large numeric IDs under agents[].lettabot.channels before conversion.
    fixLargeGroupIdsInFleetConfig(content, parsedFleet);

    const converted = fleetConfigToLettaBotConfig(parsedFleet);
    setLoadedFromFleetConfig(true);

    // Safety pass on converted top-level channels (single-agent format).
    fixLargeGroupIds(content, converted);

    // Merge with defaults and canonicalize server mode (same as native path)
    const merged = {
      ...DEFAULT_CONFIG,
      ...converted,
      server: { ...DEFAULT_CONFIG.server, ...converted.server },
      agent: { ...DEFAULT_CONFIG.agent, ...converted.agent },
      channels: { ...DEFAULT_CONFIG.channels, ...converted.channels },
    };

    return {
      ...merged,
      server: {
        ...merged.server,
        mode: canonicalizeServerMode(merged.server.mode),
      },
    };
  }

  setLoadedFromFleetConfig(false);
  const typedParsed = parsed as Partial<LettaBotConfig>;

  // Fix instantGroups: YAML parses large numeric IDs (e.g. Discord snowflakes)
  // as JavaScript numbers, losing precision for values > Number.MAX_SAFE_INTEGER.
  // Re-extract from document AST to preserve the original string representation.
  fixLargeGroupIds(content, typedParsed);

  // Reject ambiguous API server configuration. During migration from top-level
  // `api` to `server.api`, having both can silently drop fields.
  if (hasObject(typedParsed.api) && hasObject(typedParsed.server) && hasObject(typedParsed.server.api)) {
    throw new Error(
      'Conflicting API config: both top-level `api` and `server.api` are set. Remove top-level `api` and keep only `server.api`.'
    );
  }

  // Merge with defaults and canonicalize server mode.
  const merged = {
    ...DEFAULT_CONFIG,
    ...typedParsed,
    server: { ...DEFAULT_CONFIG.server, ...typedParsed.server },
    agent: { ...DEFAULT_CONFIG.agent, ...typedParsed.agent },
    channels: { ...DEFAULT_CONFIG.channels, ...typedParsed.channels },
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
    log.warn('WARNING: Top-level `api:` is deprecated. Move it under `server:`.');
  }

  return config;
}

/**
 * Load config from inline env var or YAML file
 */
export function loadConfig(): LettaBotConfig {
  _lastLoadFailed = false;
  setLoadedFromFleetConfig(false);

  // Inline config takes priority over file-based config
  if (hasInlineConfig()) {
    try {
      const content = decodeInlineConfig();
      return parseAndNormalizeConfig(content);
    } catch (err) {
      _lastLoadFailed = true;
      log.error('Failed to parse LETTABOT_CONFIG_YAML:', err);
      log.warn('Using default configuration. Check your YAML syntax.');
      return { ...DEFAULT_CONFIG };
    }
  }

  const configPath = resolveConfigPath();
  
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  
  try {
    const content = readFileSync(configPath, 'utf-8');
    return parseAndNormalizeConfig(content);
  } catch (err) {
    _lastLoadFailed = true;
    log.error(`Failed to load ${configPath}:`, err);
    log.warn('Using default configuration. Check your YAML syntax and field locations.');
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Strict config loader. Throws on invalid YAML/schema instead of silently
 * falling back to defaults.
 */
export function loadConfigStrict(): LettaBotConfig {
  _lastLoadFailed = false;
  setLoadedFromFleetConfig(false);

  // Inline config takes priority over file-based config
  if (hasInlineConfig()) {
    try {
      const content = decodeInlineConfig();
      return parseAndNormalizeConfig(content);
    } catch (err) {
      _lastLoadFailed = true;
      throw err;
    }
  }

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
  log.info(`Saved to ${configPath}`);
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
    // Signal readReceipts defaults to true, so only set env if explicitly false
    if (config.channels.signal.readReceipts === false) {
      env.SIGNAL_READ_RECEIPTS = 'false';
    }
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
  if (config.channels.matrix?.enabled !== false && config.channels.matrix?.accessToken) {
    if (config.channels.matrix.homeserverUrl) env.MATRIX_HOMESERVER_URL = config.channels.matrix.homeserverUrl;
    env.MATRIX_ACCESS_TOKEN = config.channels.matrix.accessToken;
    if (config.channels.matrix.userId) env.MATRIX_USER_ID = config.channels.matrix.userId;
    if (config.channels.matrix.deviceId) env.MATRIX_DEVICE_ID = config.channels.matrix.deviceId;
    if (config.channels.matrix.dmPolicy) env.MATRIX_DM_POLICY = config.channels.matrix.dmPolicy;
    if (config.channels.matrix.allowedUsers?.length) {
      env.MATRIX_ALLOWED_USERS = config.channels.matrix.allowedUsers.join(',');
    }
  }
  if (config.channels.bluesky?.enabled) {
    if (config.channels.bluesky.wantedDids?.length) {
      env.BLUESKY_WANTED_DIDS = config.channels.bluesky.wantedDids.join(',');
    }
    if (config.channels.bluesky.wantedCollections?.length) {
      env.BLUESKY_WANTED_COLLECTIONS = config.channels.bluesky.wantedCollections.join(',');
    }
    if (config.channels.bluesky.jetstreamUrl) {
      env.BLUESKY_JETSTREAM_URL = config.channels.bluesky.jetstreamUrl;
    }
    if (config.channels.bluesky.cursor !== undefined) {
      env.BLUESKY_CURSOR = String(config.channels.bluesky.cursor);
    }
    if (config.channels.bluesky.handle) {
      env.BLUESKY_HANDLE = config.channels.bluesky.handle;
    }
    if (config.channels.bluesky.appPassword) {
      env.BLUESKY_APP_PASSWORD = config.channels.bluesky.appPassword;
    }
    if (config.channels.bluesky.serviceUrl) {
      env.BLUESKY_SERVICE_URL = config.channels.bluesky.serviceUrl;
    }
    if (config.channels.bluesky.appViewUrl) {
      env.BLUESKY_APPVIEW_URL = config.channels.bluesky.appViewUrl;
    }
    if (config.channels.bluesky.notifications?.enabled) {
      env.BLUESKY_NOTIFICATIONS_ENABLED = 'true';
      if (config.channels.bluesky.notifications.intervalSec !== undefined) {
        env.BLUESKY_NOTIFICATIONS_INTERVAL_SEC = String(config.channels.bluesky.notifications.intervalSec);
      }
      if (config.channels.bluesky.notifications.limit !== undefined) {
        env.BLUESKY_NOTIFICATIONS_LIMIT = String(config.channels.bluesky.notifications.limit);
      }
      if (config.channels.bluesky.notifications.priority !== undefined) {
        env.BLUESKY_NOTIFICATIONS_PRIORITY = config.channels.bluesky.notifications.priority ? 'true' : 'false';
      }
      if (config.channels.bluesky.notifications.reasons?.length) {
        env.BLUESKY_NOTIFICATIONS_REASONS = config.channels.bluesky.notifications.reasons.join(',');
      }
    }
  }

  // Features
  if (config.features?.cron) {
    env.CRON_ENABLED = 'true';
  }
  if (config.features?.heartbeat?.enabled) {
    env.HEARTBEAT_INTERVAL_MIN = String(config.features.heartbeat.intervalMin || 30);
    if (config.features.heartbeat.intervalMaxMin !== undefined) {
      env.HEARTBEAT_INTERVAL_MAX_MIN = String(config.features.heartbeat.intervalMaxMin);
    }
    if (config.features.heartbeat.skipRecentUserMin !== undefined) {
      env.HEARTBEAT_SKIP_RECENT_USER_MIN = String(config.features.heartbeat.skipRecentUserMin);
    }
    if (config.features.heartbeat.skipRecentPolicy !== undefined) {
      env.HEARTBEAT_SKIP_RECENT_POLICY = config.features.heartbeat.skipRecentPolicy;
    }
    if (config.features.heartbeat.skipRecentFraction !== undefined) {
      env.HEARTBEAT_SKIP_RECENT_FRACTION = String(config.features.heartbeat.skipRecentFraction);
    }
    if (config.features.heartbeat.interruptOnUserMessage !== undefined) {
      env.HEARTBEAT_INTERRUPT_ON_USER_MESSAGE = config.features.heartbeat.interruptOnUserMessage ? 'true' : 'false';
    }
  }
  if (config.features?.sleeptime) {
    if (config.features.sleeptime.trigger) {
      env.SLEEPTIME_TRIGGER = config.features.sleeptime.trigger;
    }
    if (config.features.sleeptime.behavior) {
      env.SLEEPTIME_BEHAVIOR = config.features.sleeptime.behavior;
    }
    if (config.features.sleeptime.stepCount !== undefined) {
      env.SLEEPTIME_STEP_COUNT = String(config.features.sleeptime.stepCount);
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

  // TTS (text-to-speech for voice memos)
  if (config.tts?.provider) {
    env.TTS_PROVIDER = config.tts.provider;
  }
  if (config.tts?.apiKey) {
    // Set the provider-specific key based on provider
    const provider = config.tts.provider || 'elevenlabs';
    if (provider === 'elevenlabs') {
      env.ELEVENLABS_API_KEY = config.tts.apiKey;
    } else if (provider === 'openai') {
      env.OPENAI_API_KEY = config.tts.apiKey;
    }
  }
  if (config.tts?.voiceId) {
    const provider = config.tts.provider || 'elevenlabs';
    if (provider === 'elevenlabs') {
      env.ELEVENLABS_VOICE_ID = config.tts.voiceId;
    } else if (provider === 'openai') {
      env.OPENAI_TTS_VOICE = config.tts.voiceId;
    }
  }
  if (config.tts?.model) {
    const provider = config.tts.provider || 'elevenlabs';
    if (provider === 'elevenlabs') {
      env.ELEVENLABS_MODEL_ID = config.tts.model;
    } else if (provider === 'openai') {
      env.OPENAI_TTS_MODEL = config.tts.model;
    }
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

async function listProviders(apiKey: string): Promise<Array<{ id: string; name: string }>> {
  const listResponse = await fetch(`${LETTA_API_URL}/v1/providers`, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
  });

  if (!listResponse.ok) {
    throw new Error(`Failed to list providers: ${listResponse.status} ${listResponse.statusText}`);
  }

  return listResponse.json() as Promise<Array<{ id: string; name: string }>>;
}

/**
 * Create or update a BYOK provider on Letta API.
 * Returns whether the provider was created or updated.
 */
export async function upsertProvider(
  apiKey: string,
  provider: ProviderConfig,
  knownProviders?: Array<{ id: string; name: string }>,
): Promise<'created' | 'updated'> {
  const existingProviders = knownProviders ?? await listProviders(apiKey);
  const existing = existingProviders.find((p) => p.name === provider.name);

  if (existing) {
    const response = await fetch(`${LETTA_API_URL}/v1/providers/${existing.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ api_key: provider.apiKey }),
    });
    if (!response.ok) {
      throw new Error(`Failed to update provider ${provider.name}: ${response.status} ${response.statusText}`);
    }
    return 'updated';
  }

  const response = await fetch(`${LETTA_API_URL}/v1/providers`, {
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
  if (!response.ok) {
    throw new Error(`Failed to create provider ${provider.name}: ${response.status} ${response.statusText}`);
  }
  return 'created';
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
  
  // List existing providers once, then pass to each upsert call.
  const existingProviders = await listProviders(apiKey).catch(() => [] as Array<{ id: string; name: string }>);
  
  // Create or update each provider
  for (const provider of config.providers) {
    try {
      const action = await upsertProvider(apiKey, provider, existingProviders);
      log.info(`${action === 'updated' ? 'Updated' : 'Created'} provider: ${provider.name}`);
    } catch (err) {
      log.error(`Failed to sync provider ${provider.name}:`, err);
    }
  }
}

/**
 * Fleet config variant of large group ID preservation.
 * Targets: agents[].lettabot.channels.*.{instantGroups,listeningGroups,groups}
 */
function fixLargeGroupIdsInFleetConfig(yamlContent: string, parsed: Record<string, unknown>): void {
  const channels = ['telegram', 'slack', 'whatsapp', 'signal', 'discord'] as const;
  const groupFields = ['instantGroups', 'listeningGroups'] as const;

  const rawAgents = parsed.agents;
  if (!Array.isArray(rawAgents)) return;

  try {
    const doc = YAML.parseDocument(yamlContent);

    for (let i = 0; i < rawAgents.length; i += 1) {
      const rawAgent = rawAgents[i];
      if (!rawAgent || typeof rawAgent !== 'object' || Array.isArray(rawAgent)) continue;
      const agent = rawAgent as Record<string, unknown>;

      const rawLettabot = agent.lettabot;
      if (!rawLettabot || typeof rawLettabot !== 'object' || Array.isArray(rawLettabot)) continue;
      const lettabot = rawLettabot as Record<string, unknown>;

      const rawChannels = lettabot.channels;
      if (!rawChannels || typeof rawChannels !== 'object' || Array.isArray(rawChannels)) continue;
      const channelsConfig = rawChannels as Record<string, unknown>;

      for (const ch of channels) {
        const rawChannelCfg = channelsConfig[ch];
        if (!rawChannelCfg || typeof rawChannelCfg !== 'object' || Array.isArray(rawChannelCfg)) continue;
        const channelCfg = rawChannelCfg as Record<string, unknown>;

        for (const field of groupFields) {
          const seq = doc.getIn(['agents', i, 'lettabot', 'channels', ch, field], true);
          if (YAML.isSeq(seq)) {
            channelCfg[field] = seq.items.map((item: unknown) => {
              if (YAML.isScalar(item)) {
                if (typeof item.value === 'number' && item.source) {
                  return item.source;
                }
                return String(item.value);
              }
              return String(item);
            });
          }
        }

        const groupsNode = doc.getIn(['agents', i, 'lettabot', 'channels', ch, 'groups'], true);
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
          channelCfg.groups = fixedGroups;
        }
      }
    }
  } catch {
    for (const rawAgent of rawAgents) {
      if (!rawAgent || typeof rawAgent !== 'object' || Array.isArray(rawAgent)) continue;
      const agent = rawAgent as Record<string, unknown>;
      const rawLettabot = agent.lettabot;
      if (!rawLettabot || typeof rawLettabot !== 'object' || Array.isArray(rawLettabot)) continue;
      const lettabot = rawLettabot as Record<string, unknown>;
      const rawChannels = lettabot.channels;
      if (!rawChannels || typeof rawChannels !== 'object' || Array.isArray(rawChannels)) continue;
      const channelsConfig = rawChannels as Record<string, unknown>;

      for (const ch of channels) {
        const rawChannelCfg = channelsConfig[ch];
        if (!rawChannelCfg || typeof rawChannelCfg !== 'object' || Array.isArray(rawChannelCfg)) continue;
        const channelCfg = rawChannelCfg as Record<string, unknown>;

        for (const field of groupFields) {
          if (Array.isArray(channelCfg[field])) {
            channelCfg[field] = (channelCfg[field] as unknown[]).map((v: unknown) => String(v));
          }
        }

        if (channelCfg.groups && typeof channelCfg.groups === 'object' && !Array.isArray(channelCfg.groups)) {
          const fixedGroups: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(channelCfg.groups as Record<string, unknown>)) {
            fixedGroups[String(key)] = value;
          }
          channelCfg.groups = fixedGroups;
        }
      }
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
