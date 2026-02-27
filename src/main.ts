/**
 * LettaBot - Multi-Channel AI Assistant
 * 
 * Single agent, single conversation across all channels.
 * Chat continues seamlessly between Telegram, Slack, and WhatsApp.
 */

import { existsSync, mkdirSync, readFileSync, promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

// API server imports
import { createApiServer } from './api/server.js';
import { loadOrGenerateApiKey } from './api/auth.js';

// Load YAML config and apply to process.env (overrides .env values)
import {
  loadAppConfigOrExit,
  applyConfigToEnv,
  syncProviders,
  resolveConfigPath,
  configSourceLabel,
  hasInlineConfig,
  isDockerServerMode,
  serverModeLabel,
} from './config/index.js';
import { isLettaApiUrl } from './utils/server.js';
import { getCronDataDir, getDataDir, getWorkingDir, hasRailwayVolume, resolveWorkingDirPath } from './utils/paths.js';
import { parseCsvList, parseNonNegativeNumber } from './utils/parse.js';
import { sleep } from './utils/time.js';
import { createLogger, setLogLevel } from './logger.js';

const log = createLogger('Config');

const yamlConfig = loadAppConfigOrExit();
log.info(`Loaded from ${configSourceLabel()}`);
if (yamlConfig.agents?.length) {
  log.info(`Mode: ${serverModeLabel(yamlConfig.server.mode)}, Agents: ${yamlConfig.agents.map(a => a.name).join(', ')}`);
} else {
  log.info(`Mode: ${serverModeLabel(yamlConfig.server.mode)}, Agent: ${yamlConfig.agent.name}`);
}
if (yamlConfig.agent?.model) {
  log.warn('WARNING: agent.model in lettabot.yaml is deprecated and ignored. Use `lettabot model set <handle>` instead.');
}
applyConfigToEnv(yamlConfig);

// Apply configured log level (env vars take precedence -- handled inside setLogLevel)
if (yamlConfig.server.logLevel && !process.env.LOG_LEVEL && !process.env.LETTABOT_LOG_LEVEL) {
  setLogLevel(yamlConfig.server.logLevel);
}

// Bridge DEBUG=1 to DEBUG_SDK so SDK-level dropped wire messages are visible
if (process.env.DEBUG === '1' && !process.env.DEBUG_SDK) {
  process.env.DEBUG_SDK = '1';
}

// Sync BYOK providers on startup (async, don't block)
syncProviders(yamlConfig).catch(err => log.error('Failed to sync providers:', err));

// Load agent ID from store and set as env var (SDK needs this)
// Load agent ID from store file, or use LETTA_AGENT_ID env var as fallback
const STORE_PATH = resolve(getDataDir(), 'lettabot-agent.json');
const currentBaseUrl = process.env.LETTA_BASE_URL || 'https://api.letta.com';

if (existsSync(STORE_PATH)) {
  try {
    const raw = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
    
    // V2 format: get first agent's ID
    if (raw.version === 2 && raw.agents) {
      const firstAgent = Object.values(raw.agents)[0] as any;
      if (firstAgent?.agentId) {
        process.env.LETTA_AGENT_ID = firstAgent.agentId;
      }
      // Check server mismatch on first agent
      if (firstAgent?.agentId && firstAgent?.baseUrl) {
        const storedUrl = firstAgent.baseUrl.replace(/\/$/, '');
        const currentUrl = currentBaseUrl.replace(/\/$/, '');
        
        if (storedUrl !== currentUrl) {
          log.warn(`⚠️  Server mismatch detected!`);
          log.warn(`   Stored agent was created on: ${storedUrl}`);
          log.warn(`   Current server: ${currentUrl}`);
          log.warn(`   The agent ${firstAgent.agentId} may not exist on this server.`);
          log.warn(`   Run 'lettabot onboard' to select or create an agent for this server.`);
        }
      }
    } else if (raw.agentId) {
      // V1 format (legacy)
      process.env.LETTA_AGENT_ID = raw.agentId;
      // Check server mismatch
      if (raw.agentId && raw.baseUrl) {
        const storedUrl = raw.baseUrl.replace(/\/$/, '');
        const currentUrl = currentBaseUrl.replace(/\/$/, '');
        
        if (storedUrl !== currentUrl) {
          log.warn(`⚠️  Server mismatch detected!`);
          log.warn(`   Stored agent was created on: ${storedUrl}`);
          log.warn(`   Current server: ${currentUrl}`);
          log.warn(`   The agent ${raw.agentId} may not exist on this server.`);
          log.warn(`   Run 'lettabot onboard' to select or create an agent for this server.`);
        }
      }
    }
  } catch {}
}
// Allow LETTA_AGENT_ID env var to override (useful for local server testing)
// This is already set if passed on command line

// OAuth token refresh - check and refresh before loading SDK
import { loadTokens, saveTokens, isTokenExpired, hasRefreshToken, getDeviceName } from './auth/tokens.js';
import { refreshAccessToken } from './auth/oauth.js';

async function refreshTokensIfNeeded(): Promise<void> {
  // If env var is set, that takes precedence (no refresh needed)
  if (process.env.LETTA_API_KEY) {
    return;
  }
  
  // OAuth tokens only work with Letta API - skip if using custom server
  if (!isLettaApiUrl(process.env.LETTA_BASE_URL)) {
    return;
  }
  
  const tokens = loadTokens();
  if (!tokens?.accessToken) {
    return; // No stored tokens
  }
  
  // Set access token to env var
  process.env.LETTA_API_KEY = tokens.accessToken;
  
  // Check if token needs refresh
  if (isTokenExpired(tokens) && hasRefreshToken(tokens)) {
    try {
      log.info('Refreshing access token...');
      const newTokens = await refreshAccessToken(
        tokens.refreshToken!,
        tokens.deviceId,
        getDeviceName(),
      );
      
      // Update stored tokens
      const now = Date.now();
      saveTokens({
        accessToken: newTokens.access_token,
        refreshToken: newTokens.refresh_token ?? tokens.refreshToken,
        tokenExpiresAt: now + newTokens.expires_in * 1000,
        deviceId: tokens.deviceId,
        deviceName: tokens.deviceName,
      });
      
      // Update env var with new token
      process.env.LETTA_API_KEY = newTokens.access_token;
      log.info('Token refreshed successfully');
    } catch (err) {
      log.error('Failed to refresh token:', err instanceof Error ? err.message : err);
      log.error('You may need to re-authenticate with `lettabot onboard`');
    }
  }
}

// Run token refresh before importing SDK (which reads LETTA_API_KEY)
await refreshTokensIfNeeded();

import { normalizeAgents } from './config/types.js';
import { LettaGateway } from './core/gateway.js';
import { LettaBot } from './core/bot.js';
import { TelegramAdapter } from './channels/telegram.js';
import { TelegramMTProtoAdapter } from './channels/telegram-mtproto.js';
import { SlackAdapter } from './channels/slack.js';
import { WhatsAppAdapter } from './channels/whatsapp/index.js';
import { SignalAdapter } from './channels/signal.js';
import { DiscordAdapter } from './channels/discord.js';
import { GroupBatcher } from './core/group-batcher.js';
import { printStartupBanner } from './core/banner.js';
import { collectGroupBatchingConfig } from './core/group-batching-config.js';
import { CronService } from './cron/service.js';
import { HeartbeatService } from './cron/heartbeat.js';
import { PollingService, parseGmailAccounts } from './polling/service.js';
import { agentExists, findAgentByName, ensureNoToolApprovals } from './tools/letta-api.js';
import { isVoiceMemoConfigured } from './skills/loader.js';
// Skills are now installed to agent-scoped location after agent creation (see bot.ts)

// Check if config exists (skip when inline config, container deploy, or env vars are used)
const configPath = resolveConfigPath();
const isContainerDeploy = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.FLY_APP_NAME || process.env.DOCKER_DEPLOY);
if (!existsSync(configPath) && !isContainerDeploy && !hasInlineConfig()) {
  log.info(`
No config file found. Searched locations:
  1. LETTABOT_CONFIG_YAML env var (inline YAML or base64 - recommended for cloud)
  2. LETTABOT_CONFIG env var (file path)
  3. ./lettabot.yaml (project-local - recommended for local dev)
  4. ./lettabot.yml
  5. ~/.lettabot/config.yaml (user global)
  6. ~/.lettabot/config.yml

Run "lettabot onboard" to create a config, or set LETTABOT_CONFIG_YAML for cloud deploys.
Encode your config: base64 < lettabot.yaml | tr -d '\\n'
`);
  process.exit(1);
}

// Parse heartbeat target (format: "telegram:123456789", "slack:C1234567890", or "discord:123456789012345678")
function parseHeartbeatTarget(raw?: string): { channel: string; chatId: string } | undefined {
  if (!raw || !raw.includes(':')) return undefined;
  const [channel, chatId] = raw.split(':');
  if (!channel || !chatId) return undefined;
  return { channel: channel.toLowerCase(), chatId };
}

const DEFAULT_ATTACHMENTS_MAX_MB = 20;
const DEFAULT_ATTACHMENTS_MAX_AGE_DAYS = 14;
const ATTACHMENTS_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DISCOVERY_LOCK_TIMEOUT_MS = 15_000;
const DISCOVERY_LOCK_STALE_MS = 60_000;
const DISCOVERY_LOCK_RETRY_MS = 100;

function getDiscoveryLockPath(agentName: string): string {
  const safe = agentName
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'agent';
  return `${STORE_PATH}.${safe}.discover.lock`;
}

async function withDiscoveryLock<T>(agentName: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = getDiscoveryLockPath(agentName);
  const start = Date.now();

  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(`${process.pid}\n`, { encoding: 'utf-8' });
        return await fn();
      } finally {
        await handle.close().catch(() => {});
        await fs.rm(lockPath, { force: true }).catch(() => {});
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') {
        throw error;
      }

      try {
        const stats = await fs.stat(lockPath);
        if (Date.now() - stats.mtimeMs > DISCOVERY_LOCK_STALE_MS) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch {
        // Best-effort stale lock cleanup.
      }

      if (Date.now() - start >= DISCOVERY_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for startup discovery lock: ${lockPath}`);
      }
      await sleep(DISCOVERY_LOCK_RETRY_MS);
    }
  }
}

function resolveAttachmentsMaxBytes(): number {
  const rawBytes = Number(process.env.ATTACHMENTS_MAX_BYTES);
  if (Number.isFinite(rawBytes) && rawBytes >= 0) {
    return rawBytes;
  }
  const rawMb = Number(process.env.ATTACHMENTS_MAX_MB);
  if (Number.isFinite(rawMb) && rawMb >= 0) {
    return Math.round(rawMb * 1024 * 1024);
  }
  return DEFAULT_ATTACHMENTS_MAX_MB * 1024 * 1024;
}

function resolveAttachmentsMaxAgeDays(): number {
  const raw = Number(process.env.ATTACHMENTS_MAX_AGE_DAYS);
  if (Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  return DEFAULT_ATTACHMENTS_MAX_AGE_DAYS;
}

async function pruneAttachmentsDir(baseDir: string, maxAgeDays: number): Promise<void> {
  if (maxAgeDays <= 0) return;
  if (!existsSync(baseDir)) return;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let deleted = 0;

  const walk = async (dir: string): Promise<boolean> => {
    let entries: Array<import('node:fs').Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    let hasEntries = false;
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const childHasEntries = await walk(fullPath);
        if (!childHasEntries) {
          try {
            await fs.rmdir(fullPath);
          } catch {
            hasEntries = true;
          }
        } else {
          hasEntries = true;
        }
        continue;
      }
      if (entry.isFile()) {
        try {
          const stats = await fs.stat(fullPath);
          if (stats.mtimeMs < cutoff) {
            await fs.rm(fullPath, { force: true });
            deleted += 1;
          } else {
            hasEntries = true;
          }
        } catch {
          hasEntries = true;
        }
        continue;
      }
      hasEntries = true;
    }
    return hasEntries;
  };

  await walk(baseDir);
  if (deleted > 0) {
    log.info(`Pruned ${deleted} file(s) older than ${maxAgeDays} days.`);
  }
}

/**
 * Create channel adapters for an agent from its config
 */
function createChannelsForAgent(
  agentConfig: import('./config/types.js').AgentConfig,
  attachmentsDir: string,
  attachmentsMaxBytes: number,
): import('./channels/types.js').ChannelAdapter[] {
  const adapters: import('./channels/types.js').ChannelAdapter[] = [];

  // Mutual exclusion: cannot use both Telegram Bot API and MTProto simultaneously
  const hasTelegramBot = !!agentConfig.channels.telegram?.token;
  const hasTelegramMtproto = !!(agentConfig.channels['telegram-mtproto'] as any)?.apiId;

  if (hasTelegramBot && hasTelegramMtproto) {
    log.error(`Agent "${agentConfig.name}" has both telegram and telegram-mtproto configured.`);
    log.error('  The Bot API adapter and MTProto adapter cannot run together.');
    log.error('Choose one: telegram (bot token) or telegram-mtproto (user account).');
    process.exit(1);
  }

  if (hasTelegramBot) {
    adapters.push(new TelegramAdapter({
      token: agentConfig.channels.telegram!.token!,
      dmPolicy: agentConfig.channels.telegram!.dmPolicy || 'pairing',
      allowedUsers: agentConfig.channels.telegram!.allowedUsers && agentConfig.channels.telegram!.allowedUsers.length > 0
        ? agentConfig.channels.telegram!.allowedUsers.map(u => typeof u === 'string' ? parseInt(u, 10) : u)
        : undefined,
      attachmentsDir,
      attachmentsMaxBytes,
      groups: agentConfig.channels.telegram!.groups,
      mentionPatterns: agentConfig.channels.telegram!.mentionPatterns,
    }));
  }

  if (hasTelegramMtproto) {
    const mtprotoConfig = agentConfig.channels['telegram-mtproto'] as any;
    adapters.push(new TelegramMTProtoAdapter({
      apiId: mtprotoConfig.apiId,
      apiHash: mtprotoConfig.apiHash,
      phoneNumber: mtprotoConfig.phoneNumber,
      databaseDirectory: mtprotoConfig.databaseDirectory || './data/telegram-mtproto',
      dmPolicy: mtprotoConfig.dmPolicy || 'pairing',
      allowedUsers: mtprotoConfig.allowedUsers && mtprotoConfig.allowedUsers.length > 0
        ? mtprotoConfig.allowedUsers.map((u: string | number) => typeof u === 'string' ? parseInt(u, 10) : u)
        : undefined,
      groupPolicy: mtprotoConfig.groupPolicy || 'both',
      adminChatId: mtprotoConfig.adminChatId,
    }));
  }

  if (agentConfig.channels.slack?.botToken && agentConfig.channels.slack?.appToken) {
    adapters.push(new SlackAdapter({
      botToken: agentConfig.channels.slack.botToken,
      appToken: agentConfig.channels.slack.appToken,
      dmPolicy: agentConfig.channels.slack.dmPolicy || 'pairing',
      allowedUsers: agentConfig.channels.slack.allowedUsers && agentConfig.channels.slack.allowedUsers.length > 0
        ? agentConfig.channels.slack.allowedUsers
        : undefined,
      attachmentsDir,
      attachmentsMaxBytes,
      groups: agentConfig.channels.slack.groups,
    }));
  }

  if (agentConfig.channels.whatsapp?.enabled) {
    const selfChatMode = agentConfig.channels.whatsapp.selfChat ?? true;
    if (!selfChatMode) {
      log.warn('WARNING: selfChatMode is OFF - bot will respond to ALL incoming messages!');
      log.warn('Only use this if this is a dedicated bot number, not your personal WhatsApp.');
    }
    adapters.push(new WhatsAppAdapter({
      sessionPath: agentConfig.channels.whatsapp.sessionPath || process.env.WHATSAPP_SESSION_PATH || './data/whatsapp-session',
      dmPolicy: agentConfig.channels.whatsapp.dmPolicy || 'pairing',
      allowedUsers: agentConfig.channels.whatsapp.allowedUsers && agentConfig.channels.whatsapp.allowedUsers.length > 0
        ? agentConfig.channels.whatsapp.allowedUsers
        : undefined,
      selfChatMode,
      attachmentsDir,
      attachmentsMaxBytes,
      groups: agentConfig.channels.whatsapp.groups,
      mentionPatterns: agentConfig.channels.whatsapp.mentionPatterns,
    }));
  }

  if (agentConfig.channels.signal?.phone) {
    const selfChatMode = agentConfig.channels.signal.selfChat ?? true;
    if (!selfChatMode) {
      log.warn('WARNING: selfChatMode is OFF - bot will respond to ALL incoming messages!');
      log.warn('Only use this if this is a dedicated bot number, not your personal Signal.');
    }
    adapters.push(new SignalAdapter({
      phoneNumber: agentConfig.channels.signal.phone,
      cliPath: agentConfig.channels.signal.cliPath || process.env.SIGNAL_CLI_PATH || 'signal-cli',
      httpHost: agentConfig.channels.signal.httpHost || process.env.SIGNAL_HTTP_HOST || '127.0.0.1',
      httpPort: agentConfig.channels.signal.httpPort || parseInt(process.env.SIGNAL_HTTP_PORT || '8090', 10),
      dmPolicy: agentConfig.channels.signal.dmPolicy || 'pairing',
      allowedUsers: agentConfig.channels.signal.allowedUsers && agentConfig.channels.signal.allowedUsers.length > 0
        ? agentConfig.channels.signal.allowedUsers
        : undefined,
      selfChatMode,
      attachmentsDir,
      attachmentsMaxBytes,
      groups: agentConfig.channels.signal.groups,
      mentionPatterns: agentConfig.channels.signal.mentionPatterns,
    }));
  }

  if (agentConfig.channels.discord?.token) {
    adapters.push(new DiscordAdapter({
      token: agentConfig.channels.discord.token,
      dmPolicy: agentConfig.channels.discord.dmPolicy || 'pairing',
      allowedUsers: agentConfig.channels.discord.allowedUsers && agentConfig.channels.discord.allowedUsers.length > 0
        ? agentConfig.channels.discord.allowedUsers
        : undefined,
      attachmentsDir,
      attachmentsMaxBytes,
      groups: agentConfig.channels.discord.groups,
    }));
  }

  return adapters;
}

/**
 * Create and configure a group batcher for an agent
 */
function createGroupBatcher(
  agentConfig: import('./config/types.js').AgentConfig,
  bot: import('./core/interfaces.js').AgentSession,
): { batcher: GroupBatcher | null; intervals: Map<string, number>; instantIds: Set<string>; listeningIds: Set<string> } {
  const { intervals, instantIds, listeningIds } = collectGroupBatchingConfig(agentConfig.channels);

  if (instantIds.size > 0) {
    log.info(`Instant groups: ${[...instantIds].join(', ')}`);
  }
  if (listeningIds.size > 0) {
    log.info(`Listening groups: ${[...listeningIds].join(', ')}`);
  }

  const batcher = intervals.size > 0 ? new GroupBatcher((msg, adapter) => {
    bot.processGroupBatch(msg, adapter);
  }) : null;

  return { batcher, intervals, instantIds, listeningIds };
}

// Skills are installed to agent-scoped directory when agent is created (see core/bot.ts)

function ensureRequiredTools(tools: string[]): string[] {
  const out = [...tools];
  if (!out.includes('manage_todo')) {
    out.push('manage_todo');
  }
  return out;
}

// Global config (shared across all agents)
const globalConfig = {
  workingDir: getWorkingDir(),
  allowedTools: ensureRequiredTools(
    yamlConfig.features?.allowedTools ??
    parseCsvList(process.env.ALLOWED_TOOLS || 'Bash,Read,Edit,Write,Glob,Grep,Task,web_search,conversation_search'),
  ),
  disallowedTools:
    yamlConfig.features?.disallowedTools ??
    parseCsvList(process.env.DISALLOWED_TOOLS || 'EnterPlanMode,ExitPlanMode'),
  attachmentsMaxBytes: resolveAttachmentsMaxBytes(),
  attachmentsMaxAgeDays: resolveAttachmentsMaxAgeDays(),
  cronEnabled: process.env.CRON_ENABLED === 'true',  // Legacy env var fallback
  heartbeatSkipRecentUserMin: parseNonNegativeNumber(process.env.HEARTBEAT_SKIP_RECENT_USER_MIN),
};

// Validate LETTA_API_KEY is set for API mode (docker mode doesn't require it)
if (!isDockerServerMode(yamlConfig.server.mode) && !process.env.LETTA_API_KEY) {
  log.error('LETTA_API_KEY is required for Letta API.');
  log.error('  Get your API key from https://app.letta.com and set it as an environment variable.');
  log.error('Or use docker mode: run "lettabot onboard" and select "Enter Docker server URL".');
  process.exit(1);
}

async function main() {
  log.info('Starting LettaBot...');
  
  // Log storage locations (helpful for Railway debugging)
  const dataDir = getDataDir();
  if (hasRailwayVolume()) {
    log.info(`Railway volume detected at ${process.env.RAILWAY_VOLUME_MOUNT_PATH}`);
  }
  log.info(`Data directory: ${dataDir}`);
  log.info(`Working directory: ${globalConfig.workingDir}`);
  process.env.LETTABOT_WORKING_DIR = globalConfig.workingDir;
  
  // Normalize config to agents array
  const agents = normalizeAgents(yamlConfig);
  const isMultiAgent = agents.length > 1;
  log.info(`${agents.length} agent(s) configured: ${agents.map(a => a.name).join(', ')}`);
  
  // Validate at least one agent has channels
  const totalChannels = agents.reduce((sum, a) => sum + Object.keys(a.channels).length, 0);
  if (totalChannels === 0) {
    log.error('No channels configured in any agent.');
    log.error('Configure channels in lettabot.yaml or set environment variables.');
    process.exit(1);
  }

  const attachmentsDir = resolve(globalConfig.workingDir, 'attachments');
  pruneAttachmentsDir(attachmentsDir, globalConfig.attachmentsMaxAgeDays).catch((err) => {
    log.warn('Prune failed:', err);
  });
  if (globalConfig.attachmentsMaxAgeDays > 0) {
    const timer = setInterval(() => {
      pruneAttachmentsDir(attachmentsDir, globalConfig.attachmentsMaxAgeDays).catch((err) => {
        log.warn('Prune failed:', err);
      });
    }, ATTACHMENTS_PRUNE_INTERVAL_MS);
    timer.unref?.();
  }
  
  const gateway = new LettaGateway();
  const voiceMemoEnabled = isVoiceMemoConfigured();
  const services: { 
    cronServices: CronService[], 
    heartbeatServices: HeartbeatService[], 
    pollingServices: PollingService[], 
    groupBatchers: GroupBatcher[] 
  } = {
    cronServices: [],
    heartbeatServices: [],
    pollingServices: [],
    groupBatchers: [],
  };
  
  for (const agentConfig of agents) {
    log.info(`Configuring agent: ${agentConfig.name}`);
    
    // Resolve memfs: YAML config takes precedence, then env var, then default false.
    // Default false prevents the SDK from auto-enabling memfs, which crashes on
    // self-hosted Letta servers that don't have the git endpoint.
    const resolvedMemfs = agentConfig.features?.memfs ?? (process.env.LETTABOT_MEMFS === 'true' ? true : false);

    // Create LettaBot for this agent
    const resolvedWorkingDir = agentConfig.workingDir
      ? resolveWorkingDirPath(agentConfig.workingDir)
      : globalConfig.workingDir;
    // Per-agent cron store path: in multi-agent mode, each agent gets its own file
    const cronStoreFilename = agents.length > 1
      ? `cron-jobs-${agentConfig.name}.json`
      : undefined;
    const cronStorePath = cronStoreFilename
      ? resolve(getCronDataDir(), cronStoreFilename)
      : undefined;

    const bot = new LettaBot({
      workingDir: resolvedWorkingDir,
      agentName: agentConfig.name,
      allowedTools: ensureRequiredTools(agentConfig.features?.allowedTools ?? globalConfig.allowedTools),
      disallowedTools: agentConfig.features?.disallowedTools ?? globalConfig.disallowedTools,
      displayName: agentConfig.displayName,
      maxToolCalls: agentConfig.features?.maxToolCalls,
      sendFileDir: agentConfig.features?.sendFileDir,
      sendFileMaxSize: agentConfig.features?.sendFileMaxSize,
      sendFileCleanup: agentConfig.features?.sendFileCleanup,
      memfs: resolvedMemfs,
      display: agentConfig.features?.display,
      conversationMode: agentConfig.conversations?.mode || 'shared',
      heartbeatConversation: agentConfig.conversations?.heartbeat || 'last-active',
      conversationOverrides: agentConfig.conversations?.perChannel,
      maxSessions: agentConfig.conversations?.maxSessions,
      redaction: agentConfig.security?.redaction,
      cronStorePath,
      skills: {
        cronEnabled: agentConfig.features?.cron ?? globalConfig.cronEnabled,
        googleEnabled: !!agentConfig.integrations?.google?.enabled || !!agentConfig.polling?.gmail?.enabled,
        ttsEnabled: voiceMemoEnabled,
      },
    });
    
    // Log memfs config (from either YAML or env var)
    if (resolvedMemfs !== undefined) {
      const source = agentConfig.features?.memfs !== undefined ? '' : ' (from LETTABOT_MEMFS env)';
      log.info(`Agent ${agentConfig.name}: memfs ${resolvedMemfs ? 'enabled' : 'disabled'}${source}`);
    }

    // Apply explicit agent ID from config (before store verification)
    let initialStatus = bot.getStatus();
    if (agentConfig.id && !initialStatus.agentId) {
      log.info(`Using configured agent ID: ${agentConfig.id}`);
      bot.setAgentId(agentConfig.id);
      initialStatus = bot.getStatus();
    }
    
    // Verify agent exists (clear stale ID if deleted)
    if (initialStatus.agentId) {
      const exists = await agentExists(initialStatus.agentId);
      if (!exists) {
        log.info(`Stored agent ${initialStatus.agentId} not found on server`);
        bot.reset();
        initialStatus = bot.getStatus();
      }
    }

    // Container deploy: discover by name under an inter-process lock to avoid startup races.
    if (!initialStatus.agentId && isContainerDeploy) {
      try {
        await withDiscoveryLock(agentConfig.name, async () => {
          // Re-read status after lock acquisition in case another instance already set it.
          initialStatus = bot.getStatus();
          if (initialStatus.agentId) return;

          const found = await findAgentByName(agentConfig.name);
          if (found) {
            log.info(`Found existing agent: ${found.id}`);
            bot.setAgentId(found.id);
            initialStatus = bot.getStatus();
          }
        });
      } catch (error) {
        log.warn(
          `Discovery lock failed for ${agentConfig.name}:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    if (!initialStatus.agentId) {
      log.info(`No agent found - will create on first message`);
    }
    
    // Disable tool approvals
    if (initialStatus.agentId) {
      ensureNoToolApprovals(initialStatus.agentId).catch(err => {
        log.warn(`Failed to check tool approvals:`, err);
      });
    }

    // Create and register channels
    const adapters = createChannelsForAgent(agentConfig, attachmentsDir, globalConfig.attachmentsMaxBytes);
    for (const adapter of adapters) {
      bot.registerChannel(adapter);
    }

    // Setup group batching
    const { batcher, intervals, instantIds, listeningIds } = createGroupBatcher(agentConfig, bot);
    if (batcher) {
      bot.setGroupBatcher(batcher, intervals, instantIds, listeningIds);
      services.groupBatchers.push(batcher);
    }

    // Pre-warm the SDK session subprocess so the first message doesn't pay startup cost
    bot.warmSession().catch(() => {});

    // Per-agent cron
    if (agentConfig.features?.cron ?? globalConfig.cronEnabled) {
      const cronService = new CronService(bot, cronStoreFilename ? { storePath: cronStoreFilename } : undefined);
      await cronService.start();
      services.cronServices.push(cronService);
    }

    // Per-agent heartbeat
    const heartbeatConfig = agentConfig.features?.heartbeat;
    const heartbeatService = new HeartbeatService(bot, {
      enabled: heartbeatConfig?.enabled ?? false,
      intervalMinutes: heartbeatConfig?.intervalMin ?? 30,
      skipRecentUserMinutes: heartbeatConfig?.skipRecentUserMin ?? globalConfig.heartbeatSkipRecentUserMin,
      agentKey: agentConfig.name,
      prompt: heartbeatConfig?.prompt || process.env.HEARTBEAT_PROMPT,
      promptFile: heartbeatConfig?.promptFile,
      workingDir: resolvedWorkingDir,
      target: parseHeartbeatTarget(heartbeatConfig?.target) || parseHeartbeatTarget(process.env.HEARTBEAT_TARGET),
    });
    if (heartbeatConfig?.enabled) {
      heartbeatService.start();
      services.heartbeatServices.push(heartbeatService);
    }
    bot.onTriggerHeartbeat = () => heartbeatService.trigger();
    
    // Per-agent polling -- resolve accounts from polling > integrations.google (legacy) > env
    const pollConfig = (() => {
      const pollingAccounts = parseGmailAccounts(
        agentConfig.polling?.gmail?.accounts || agentConfig.polling?.gmail?.account
      );
      const legacyAccounts = (() => {
        const legacy = agentConfig.integrations?.google;
        if (legacy?.accounts?.length) {
          return parseGmailAccounts(legacy.accounts.map(a => a.account));
        }
        return parseGmailAccounts(legacy?.account);
      })();
      const envAccounts = parseGmailAccounts(process.env.GMAIL_ACCOUNT);
      const gmailAccounts = pollingAccounts.length > 0
        ? pollingAccounts
        : legacyAccounts.length > 0
          ? legacyAccounts
          : envAccounts;
      const gmailEnabled = agentConfig.polling?.gmail?.enabled
        ?? agentConfig.integrations?.google?.enabled
        ?? gmailAccounts.length > 0;
      return {
        enabled: agentConfig.polling?.enabled ?? gmailEnabled,
        intervalMs: agentConfig.polling?.intervalMs
          ?? (agentConfig.integrations?.google?.pollIntervalSec
            ? agentConfig.integrations.google.pollIntervalSec * 1000
            : 60000),
        gmail: { enabled: gmailEnabled, accounts: gmailAccounts },
      };
    })();
    
    if (pollConfig.enabled && pollConfig.gmail.enabled && pollConfig.gmail.accounts.length > 0) {
      const pollingService = new PollingService(bot, {
        intervalMs: pollConfig.intervalMs,
        workingDir: resolvedWorkingDir,
        gmail: pollConfig.gmail,
      });
      pollingService.start();
      services.pollingServices.push(pollingService);
    }
    
    gateway.addAgent(agentConfig.name, bot);
  }
  
  // Start all agents
  await gateway.start();
  
  // Load/generate API key for CLI authentication
  const apiKey = loadOrGenerateApiKey();
  log.info(`Key: ${apiKey.slice(0, 8)}... (set LETTABOT_API_KEY to customize)`);

  // Start API server - uses gateway for delivery
  const apiPort = parseInt(process.env.PORT || '8080', 10);
  const apiHost = process.env.API_HOST || (isContainerDeploy ? '0.0.0.0' : undefined); // Container platforms need 0.0.0.0 for health checks
  const apiCorsOrigin = process.env.API_CORS_ORIGIN; // undefined = same-origin only
  const apiServer = createApiServer(gateway, {
    port: apiPort,
    apiKey: apiKey,
    host: apiHost,
    corsOrigin: apiCorsOrigin,
  });
  
  // Startup banner
  const bannerAgents = gateway.getAgentNames().map(name => {
    const agent = gateway.getAgent(name)!;
    const status = agent.getStatus();
    const cfg = agents.find(a => a.name === name);
    const hbCfg = cfg?.features?.heartbeat;
    return {
      name,
      agentId: status.agentId,
      conversationId: status.conversationId,
      channels: status.channels,
      features: {
        cron: cfg?.features?.cron ?? globalConfig.cronEnabled,
        heartbeatIntervalMin: hbCfg?.enabled ? (hbCfg.intervalMin ?? 30) : undefined,
      },
    };
  });
  if (!process.env.LETTABOT_NO_BANNER) {
    printStartupBanner(bannerAgents);
  }
  
  // Shutdown
  const shutdown = async () => {
    log.info('Shutting down...');
    services.groupBatchers.forEach(b => b.stop());
    services.heartbeatServices.forEach(h => h.stop());
    services.cronServices.forEach(c => c.stop());
    services.pollingServices.forEach(p => p.stop());
    await gateway.stop();
    process.exit(0);
  };
  
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  log.error('Fatal error:', e);
  process.exit(1);
});
