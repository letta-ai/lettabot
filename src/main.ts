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
import { loadConfig, applyConfigToEnv, syncProviders, resolveConfigPath } from './config/index.js';
import { isLettaCloudUrl } from './utils/server.js';
import { getDataDir, getWorkingDir, hasRailwayVolume } from './utils/paths.js';
const yamlConfig = loadConfig();
const configSource = existsSync(resolveConfigPath()) ? resolveConfigPath() : 'defaults + environment variables';
console.log(`[Config] Loaded from ${configSource}`);
if (yamlConfig.agents?.length) {
  console.log(`[Config] Mode: ${yamlConfig.server.mode}, Agents: ${yamlConfig.agents.map(a => a.name).join(', ')}`);
} else {
  console.log(`[Config] Mode: ${yamlConfig.server.mode}, Agent: ${yamlConfig.agent.name}, Model: ${yamlConfig.agent.model}`);
}
applyConfigToEnv(yamlConfig);

// Sync BYOK providers on startup (async, don't block)
syncProviders(yamlConfig).catch(err => console.error('[Config] Failed to sync providers:', err));

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
          console.warn(`\n⚠️  Server mismatch detected!`);
          console.warn(`   Stored agent was created on: ${storedUrl}`);
          console.warn(`   Current server: ${currentUrl}`);
          console.warn(`   The agent ${firstAgent.agentId} may not exist on this server.`);
          console.warn(`   Run 'lettabot onboard' to select or create an agent for this server.\n`);
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
          console.warn(`\n⚠️  Server mismatch detected!`);
          console.warn(`   Stored agent was created on: ${storedUrl}`);
          console.warn(`   Current server: ${currentUrl}`);
          console.warn(`   The agent ${raw.agentId} may not exist on this server.`);
          console.warn(`   Run 'lettabot onboard' to select or create an agent for this server.\n`);
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
  
  // OAuth tokens only work with Letta Cloud - skip if using custom server
  if (!isLettaCloudUrl(process.env.LETTA_BASE_URL)) {
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
      console.log('[OAuth] Refreshing access token...');
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
      console.log('[OAuth] Token refreshed successfully');
    } catch (err) {
      console.error('[OAuth] Failed to refresh token:', err instanceof Error ? err.message : err);
      console.error('[OAuth] You may need to re-authenticate with `lettabot onboard`');
    }
  }
}

// Run token refresh before importing SDK (which reads LETTA_API_KEY)
await refreshTokensIfNeeded();

import { normalizeAgents } from './config/types.js';
import { LettaGateway } from './core/gateway.js';
import { LettaBot } from './core/bot.js';
import { TelegramAdapter } from './channels/telegram.js';
import { SlackAdapter } from './channels/slack.js';
import { WhatsAppAdapter } from './channels/whatsapp/index.js';
import { SignalAdapter } from './channels/signal.js';
import { DiscordAdapter } from './channels/discord.js';
import { GroupBatcher } from './core/group-batcher.js';
import { CronService } from './cron/service.js';
import { HeartbeatService } from './cron/heartbeat.js';
import { PollingService } from './polling/service.js';
import { agentExists, findAgentByName, ensureNoToolApprovals } from './tools/letta-api.js';
// Skills are now installed to agent-scoped location after agent creation (see bot.ts)

// Check if config exists (skip in Railway/Docker where env vars are used directly)
const configPath = resolveConfigPath();
const isContainerDeploy = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.FLY_APP_NAME || process.env.DOCKER_DEPLOY);
if (!existsSync(configPath) && !isContainerDeploy) {
  console.log(`
No config file found. Searched locations:
  1. LETTABOT_CONFIG env var (not set)
  2. ./lettabot.yaml (project-local - recommended)
  3. ./lettabot.yml
  4. ~/.lettabot/config.yaml (user global)
  5. ~/.lettabot/config.yml

Run "lettabot onboard" to create a config, or set LETTABOT_CONFIG=/path/to/config.yaml
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
    console.log(`[Attachments] Pruned ${deleted} file(s) older than ${maxAgeDays} days.`);
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

  if (agentConfig.channels.telegram?.token) {
    adapters.push(new TelegramAdapter({
      token: agentConfig.channels.telegram.token,
      dmPolicy: agentConfig.channels.telegram.dmPolicy || 'pairing',
      allowedUsers: agentConfig.channels.telegram.allowedUsers && agentConfig.channels.telegram.allowedUsers.length > 0
        ? agentConfig.channels.telegram.allowedUsers.map(u => typeof u === 'string' ? parseInt(u, 10) : u)
        : undefined,
      attachmentsDir,
      attachmentsMaxBytes,
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
    }));
  }

  if (agentConfig.channels.whatsapp?.enabled) {
    const selfChatMode = agentConfig.channels.whatsapp.selfChat ?? true;
    if (!selfChatMode) {
      console.warn('[WhatsApp] WARNING: selfChatMode is OFF - bot will respond to ALL incoming messages!');
      console.warn('[WhatsApp] Only use this if this is a dedicated bot number, not your personal WhatsApp.');
    }
    adapters.push(new WhatsAppAdapter({
      sessionPath: process.env.WHATSAPP_SESSION_PATH || './data/whatsapp-session',
      dmPolicy: agentConfig.channels.whatsapp.dmPolicy || 'pairing',
      allowedUsers: agentConfig.channels.whatsapp.allowedUsers && agentConfig.channels.whatsapp.allowedUsers.length > 0
        ? agentConfig.channels.whatsapp.allowedUsers
        : undefined,
      selfChatMode,
      attachmentsDir,
      attachmentsMaxBytes,
    }));
  }

  if (agentConfig.channels.signal?.phone) {
    const selfChatMode = agentConfig.channels.signal.selfChat ?? true;
    if (!selfChatMode) {
      console.warn('[Signal] WARNING: selfChatMode is OFF - bot will respond to ALL incoming messages!');
      console.warn('[Signal] Only use this if this is a dedicated bot number, not your personal Signal.');
    }
    adapters.push(new SignalAdapter({
      phoneNumber: agentConfig.channels.signal.phone,
      cliPath: process.env.SIGNAL_CLI_PATH || 'signal-cli',
      httpHost: process.env.SIGNAL_HTTP_HOST || '127.0.0.1',
      httpPort: parseInt(process.env.SIGNAL_HTTP_PORT || '8090', 10),
      dmPolicy: agentConfig.channels.signal.dmPolicy || 'pairing',
      allowedUsers: agentConfig.channels.signal.allowedUsers && agentConfig.channels.signal.allowedUsers.length > 0
        ? agentConfig.channels.signal.allowedUsers
        : undefined,
      selfChatMode,
      attachmentsDir,
      attachmentsMaxBytes,
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
): { batcher: GroupBatcher | null; intervals: Map<string, number>; instantIds: Set<string> } {
  const intervals = new Map<string, number>();
  const instantIds = new Set<string>();

  // Collect intervals from channel configs
  if (agentConfig.channels.telegram) {
    intervals.set('telegram', agentConfig.channels.telegram.groupPollIntervalMin ?? 10);
    for (const id of agentConfig.channels.telegram.instantGroups || []) {
      instantIds.add(`telegram:${id}`);
    }
  }
  if (agentConfig.channels.slack) {
    intervals.set('slack', agentConfig.channels.slack.groupPollIntervalMin ?? 10);
    for (const id of agentConfig.channels.slack.instantGroups || []) {
      instantIds.add(`slack:${id}`);
    }
  }
  if (agentConfig.channels.whatsapp) {
    intervals.set('whatsapp', agentConfig.channels.whatsapp.groupPollIntervalMin ?? 10);
    for (const id of agentConfig.channels.whatsapp.instantGroups || []) {
      instantIds.add(`whatsapp:${id}`);
    }
  }
  if (agentConfig.channels.signal) {
    intervals.set('signal', agentConfig.channels.signal.groupPollIntervalMin ?? 10);
    for (const id of agentConfig.channels.signal.instantGroups || []) {
      instantIds.add(`signal:${id}`);
    }
  }
  if (agentConfig.channels.discord) {
    intervals.set('discord', agentConfig.channels.discord.groupPollIntervalMin ?? 10);
    for (const id of agentConfig.channels.discord.instantGroups || []) {
      instantIds.add(`discord:${id}`);
    }
  }

  if (instantIds.size > 0) {
    console.log(`[Groups] Instant groups: ${[...instantIds].join(', ')}`);
  }

  const batcher = intervals.size > 0 ? new GroupBatcher((msg, adapter) => {
    bot.processGroupBatch(msg, adapter);
  }) : null;

  return { batcher, intervals, instantIds };
}

// Skills are installed to agent-scoped directory when agent is created (see core/bot.ts)

// Global config (shared across all agents)
const globalConfig = {
  workingDir: getWorkingDir(),
  allowedTools: (process.env.ALLOWED_TOOLS || 'Bash,Read,Edit,Write,Glob,Grep,Task,web_search,conversation_search').split(','),
  attachmentsMaxBytes: resolveAttachmentsMaxBytes(),
  attachmentsMaxAgeDays: resolveAttachmentsMaxAgeDays(),
  cronEnabled: process.env.CRON_ENABLED === 'true',  // Legacy env var fallback
};

// Validate LETTA_API_KEY is set for cloud mode (selfhosted mode doesn't require it)
if (yamlConfig.server.mode !== 'selfhosted' && !process.env.LETTA_API_KEY) {
  console.error('\n  Error: LETTA_API_KEY is required for Letta Cloud.');
  console.error('  Get your API key from https://app.letta.com and set it as an environment variable.');
  console.error('  Or use selfhosted mode: run "lettabot onboard" and select "Enter self-hosted URL".\n');
  process.exit(1);
}

async function main() {
  console.log('Starting LettaBot...\n');
  
  // Log storage locations (helpful for Railway debugging)
  const dataDir = getDataDir();
  if (hasRailwayVolume()) {
    console.log(`[Storage] Railway volume detected at ${process.env.RAILWAY_VOLUME_MOUNT_PATH}`);
  }
  console.log(`[Storage] Data directory: ${dataDir}`);
  console.log(`[Storage] Working directory: ${globalConfig.workingDir}`);
  
  // Normalize config to agents array
  const agents = normalizeAgents(yamlConfig);
  const isMultiAgent = agents.length > 1;
  console.log(`[Config] ${agents.length} agent(s) configured: ${agents.map(a => a.name).join(', ')}`);
  
  // Validate at least one agent has channels
  const totalChannels = agents.reduce((sum, a) => sum + Object.keys(a.channels).length, 0);
  if (totalChannels === 0) {
    console.error('\n  Error: No channels configured in any agent.');
    console.error('  Configure channels in lettabot.yaml or set environment variables.\n');
    process.exit(1);
  }

  const attachmentsDir = resolve(globalConfig.workingDir, 'attachments');
  pruneAttachmentsDir(attachmentsDir, globalConfig.attachmentsMaxAgeDays).catch((err) => {
    console.warn('[Attachments] Prune failed:', err);
  });
  if (globalConfig.attachmentsMaxAgeDays > 0) {
    const timer = setInterval(() => {
      pruneAttachmentsDir(attachmentsDir, globalConfig.attachmentsMaxAgeDays).catch((err) => {
        console.warn('[Attachments] Prune failed:', err);
      });
    }, ATTACHMENTS_PRUNE_INTERVAL_MS);
    timer.unref?.();
  }
  
  const gateway = new LettaGateway();
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
    console.log(`\n[Setup] Configuring agent: ${agentConfig.name}`);
    
    // Create LettaBot for this agent
    const bot = new LettaBot({
      workingDir: globalConfig.workingDir,
      agentName: agentConfig.name,
      model: agentConfig.model,
      allowedTools: globalConfig.allowedTools,
      maxToolCalls: agentConfig.features?.maxToolCalls,
      skills: {
        cronEnabled: agentConfig.features?.cron ?? globalConfig.cronEnabled,
        googleEnabled: !!agentConfig.integrations?.google?.enabled || !!agentConfig.polling?.gmail?.enabled,
      },
    });
    
    // Apply explicit agent ID from config (before store verification)
    let initialStatus = bot.getStatus();
    if (agentConfig.id && !initialStatus.agentId) {
      console.log(`[Agent:${agentConfig.name}] Using configured agent ID: ${agentConfig.id}`);
      bot.setAgentId(agentConfig.id);
      initialStatus = bot.getStatus();
    }
    
    // Verify agent exists (clear stale ID if deleted)
    if (initialStatus.agentId) {
      const exists = await agentExists(initialStatus.agentId);
      if (!exists) {
        console.log(`[Agent:${agentConfig.name}] Stored agent ${initialStatus.agentId} not found on server`);
        bot.reset();
        initialStatus = bot.getStatus();
      }
    }
    
    // Container deploy: discover by name
    if (!initialStatus.agentId && isContainerDeploy) {
      const found = await findAgentByName(agentConfig.name);
      if (found) {
        console.log(`[Agent:${agentConfig.name}] Found existing agent: ${found.id}`);
        bot.setAgentId(found.id);
        initialStatus = bot.getStatus();
      }
    }
    
    if (!initialStatus.agentId) {
      console.log(`[Agent:${agentConfig.name}] No agent found - will create on first message`);
    }
    
    // Disable tool approvals
    if (initialStatus.agentId) {
      ensureNoToolApprovals(initialStatus.agentId).catch(err => {
        console.warn(`[Agent:${agentConfig.name}] Failed to check tool approvals:`, err);
      });
    }
    
    // Create and register channels
    const adapters = createChannelsForAgent(agentConfig, attachmentsDir, globalConfig.attachmentsMaxBytes);
    for (const adapter of adapters) {
      bot.registerChannel(adapter);
    }
    
    // Setup group batching
    const { batcher, intervals, instantIds } = createGroupBatcher(agentConfig, bot);
    if (batcher) {
      bot.setGroupBatcher(batcher, intervals, instantIds);
      services.groupBatchers.push(batcher);
    }
    
    // Per-agent cron
    if (agentConfig.features?.cron ?? globalConfig.cronEnabled) {
      const cronService = new CronService(bot);
      await cronService.start();
      services.cronServices.push(cronService);
    }
    
    // Per-agent heartbeat
    const heartbeatConfig = agentConfig.features?.heartbeat;
    const heartbeatService = new HeartbeatService(bot, {
      enabled: heartbeatConfig?.enabled ?? false,
      intervalMinutes: heartbeatConfig?.intervalMin ?? 30,
      prompt: process.env.HEARTBEAT_PROMPT,
      workingDir: globalConfig.workingDir,
      target: parseHeartbeatTarget(process.env.HEARTBEAT_TARGET),
    });
    if (heartbeatConfig?.enabled) {
      heartbeatService.start();
      services.heartbeatServices.push(heartbeatService);
    }
    bot.onTriggerHeartbeat = () => heartbeatService.trigger();
    
    // Per-agent polling
    const pollConfig = agentConfig.polling || (agentConfig.integrations?.google ? {
      enabled: agentConfig.integrations.google.enabled,
      intervalMs: (agentConfig.integrations.google.pollIntervalSec || 60) * 1000,
      gmail: {
        enabled: agentConfig.integrations.google.enabled,
        account: agentConfig.integrations.google.account || '',
      },
    } : undefined);
    
    if (pollConfig?.enabled && pollConfig.gmail?.enabled) {
      const pollingService = new PollingService(bot, {
        intervalMs: pollConfig.intervalMs || 60000,
        workingDir: globalConfig.workingDir,
        gmail: {
          enabled: pollConfig.gmail.enabled,
          account: pollConfig.gmail.account || '',
        },
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
  console.log(`[API] Key: ${apiKey.slice(0, 8)}... (set LETTABOT_API_KEY to customize)`);

  // Start API server - uses gateway for delivery
  const apiPort = parseInt(process.env.PORT || '8080', 10);
  const apiHost = process.env.API_HOST; // undefined = 127.0.0.1 (secure default)
  const apiCorsOrigin = process.env.API_CORS_ORIGIN; // undefined = same-origin only
  const apiServer = createApiServer(gateway, {
    port: apiPort,
    apiKey: apiKey,
    host: apiHost,
    corsOrigin: apiCorsOrigin,
  });
  
  // Status logging
  console.log('\n=================================');
  console.log(`LettaBot is running! (${gateway.size} agent${gateway.size > 1 ? 's' : ''})`);
  console.log('=================================');
  for (const name of gateway.getAgentNames()) {
    const status = gateway.getAgent(name)!.getStatus();
    console.log(`  ${name}: ${status.agentId || '(pending)'} [${status.channels.join(', ')}]`);
  }
  console.log('=================================\n');
  
  // Shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
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
  console.error('Fatal error:', e);
  process.exit(1);
});
