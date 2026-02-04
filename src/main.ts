/**
 * LettaBot - Multi-Channel AI Assistant
 * 
 * Single agent, single conversation across all channels.
 * Chat continues seamlessly between Telegram, Slack, and WhatsApp.
 */

import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

// Load YAML config and apply to process.env (overrides .env values)
import { loadConfig, applyConfigToEnv, syncProviders, resolveConfigPath } from './config/index.js';
import { isLettaCloudUrl } from './utils/server.js';
import { getDataDir, getWorkingDir, hasRailwayVolume } from './utils/paths.js';
const yamlConfig = loadConfig();
const configSource = existsSync(resolveConfigPath()) ? resolveConfigPath() : 'defaults + environment variables';
console.log(`[Config] Loaded from ${configSource}`);
console.log(`[Config] Mode: ${yamlConfig.server.mode}, Agent: ${yamlConfig.agent.name}, Model: ${yamlConfig.agent.model}`);
applyConfigToEnv(yamlConfig);

// Sync BYOK providers on startup (async, don't block)
syncProviders(yamlConfig).catch(err => console.error('[Config] Failed to sync providers:', err));

// Load agent ID from store and set as env var (SDK needs this)
// Load agent ID from store file, or use LETTA_AGENT_ID env var as fallback
const STORE_PATH = resolve(getDataDir(), 'lettabot-agent.json');
const currentBaseUrl = process.env.LETTA_BASE_URL || 'https://api.letta.com';

if (existsSync(STORE_PATH)) {
  try {
    const store = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
    
    // Check for server mismatch
    if (store.agentId && store.baseUrl) {
      const storedUrl = store.baseUrl.replace(/\/$/, '');
      const currentUrl = currentBaseUrl.replace(/\/$/, '');
      
      if (storedUrl !== currentUrl) {
        console.warn(`\n⚠️  Server mismatch detected!`);
        console.warn(`   Stored agent was created on: ${storedUrl}`);
        console.warn(`   Current server: ${currentUrl}`);
        console.warn(`   The agent ${store.agentId} may not exist on this server.`);
        console.warn(`   Run 'lettabot onboard' to select or create an agent for this server.\n`);
      }
    }
    
    if (store.agentId) {
      process.env.LETTA_AGENT_ID = store.agentId;
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

import { LettaBot } from './core/bot.js';
import { TelegramAdapter } from './channels/telegram.js';
import { SlackAdapter } from './channels/slack.js';
import { WhatsAppAdapter } from './channels/whatsapp/index.js';
import { SignalAdapter } from './channels/signal.js';
import { DiscordAdapter } from './channels/discord.js';
import { CronService } from './cron/service.js';
import { HeartbeatService } from './cron/heartbeat.js';
import { PollingService } from './polling/service.js';
import { agentExists, findAgentByName } from './tools/letta-api.js';
import { installSkillsToWorkingDir } from './skills/loader.js';

// Check if config exists (skip in Railway/Docker where env vars are used directly)
const configPath = resolveConfigPath();
const isContainerDeploy = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.FLY_APP_NAME || process.env.DOCKER_DEPLOY);
if (!existsSync(configPath) && !isContainerDeploy) {
  console.log(`\n  No config found at ${configPath}. Run "lettabot onboard" first.\n`);
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

// Skills are installed to agent-scoped directory when agent is created (see core/bot.ts)

// Configuration from environment
const config = {
  workingDir: getWorkingDir(),
  model: process.env.MODEL, // e.g., 'claude-sonnet-4-20250514'
  allowedTools: (process.env.ALLOWED_TOOLS || 'Bash,Read,Edit,Write,Glob,Grep,Task,web_search,conversation_search').split(','),
  attachmentsMaxBytes: resolveAttachmentsMaxBytes(),
  attachmentsMaxAgeDays: resolveAttachmentsMaxAgeDays(),
  
  // Channel configs
  telegram: {
    enabled: !!process.env.TELEGRAM_BOT_TOKEN,
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    dmPolicy: (process.env.TELEGRAM_DM_POLICY || 'pairing') as 'pairing' | 'allowlist' | 'open',
    allowedUsers: process.env.TELEGRAM_ALLOWED_USERS?.split(',').filter(Boolean).map(Number) || [],
  },
  slack: {
    enabled: !!process.env.SLACK_BOT_TOKEN && !!process.env.SLACK_APP_TOKEN,
    botToken: process.env.SLACK_BOT_TOKEN || '',
    appToken: process.env.SLACK_APP_TOKEN || '',
    allowedUsers: process.env.SLACK_ALLOWED_USERS?.split(',').filter(Boolean) || [],
  },
  whatsapp: {
    enabled: process.env.WHATSAPP_ENABLED === 'true',
    sessionPath: process.env.WHATSAPP_SESSION_PATH || './data/whatsapp-session',
    dmPolicy: (process.env.WHATSAPP_DM_POLICY || 'pairing') as 'pairing' | 'allowlist' | 'open',
    allowedUsers: process.env.WHATSAPP_ALLOWED_USERS?.split(',').filter(Boolean) || [],
    selfChatMode: process.env.WHATSAPP_SELF_CHAT_MODE !== 'false', // Default true (safe - only self-chat)
  },
  signal: {
    enabled: !!process.env.SIGNAL_PHONE_NUMBER,
    phoneNumber: process.env.SIGNAL_PHONE_NUMBER || '',
    cliPath: process.env.SIGNAL_CLI_PATH || 'signal-cli',
    httpHost: process.env.SIGNAL_HTTP_HOST || '127.0.0.1',
    httpPort: parseInt(process.env.SIGNAL_HTTP_PORT || '8090', 10),
    dmPolicy: (process.env.SIGNAL_DM_POLICY || 'pairing') as 'pairing' | 'allowlist' | 'open',
    allowedUsers: process.env.SIGNAL_ALLOWED_USERS?.split(',').filter(Boolean) || [],
    selfChatMode: process.env.SIGNAL_SELF_CHAT_MODE !== 'false', // Default true
  },
  discord: {
    enabled: !!process.env.DISCORD_BOT_TOKEN,
    token: process.env.DISCORD_BOT_TOKEN || '',
    dmPolicy: (process.env.DISCORD_DM_POLICY || 'pairing') as 'pairing' | 'allowlist' | 'open',
    allowedUsers: process.env.DISCORD_ALLOWED_USERS?.split(',').filter(Boolean) || [],
  },
  
  // Cron
  cronEnabled: process.env.CRON_ENABLED === 'true',
  
  // Heartbeat - simpler config
  heartbeat: {
    enabled: !!process.env.HEARTBEAT_INTERVAL_MIN,
    intervalMinutes: parseInt(process.env.HEARTBEAT_INTERVAL_MIN || '0', 10) || 30,
    prompt: process.env.HEARTBEAT_PROMPT,
    target: parseHeartbeatTarget(process.env.HEARTBEAT_TARGET),
  },
  
  // Polling - system-level background checks
  polling: {
    enabled: !!process.env.GMAIL_ACCOUNT, // Enable if any poller is configured
    intervalMs: parseInt(process.env.POLLING_INTERVAL_MS || '60000', 10), // Default 1 minute
    gmail: {
      enabled: !!process.env.GMAIL_ACCOUNT,
      account: process.env.GMAIL_ACCOUNT || '',
    },
  },
};

// Validate at least one channel is configured
if (!config.telegram.enabled && !config.slack.enabled && !config.whatsapp.enabled && !config.signal.enabled && !config.discord.enabled) {
  console.error('\n  Error: No channels configured.');
  console.error('  Set TELEGRAM_BOT_TOKEN, SLACK_BOT_TOKEN+SLACK_APP_TOKEN, WHATSAPP_ENABLED=true, SIGNAL_PHONE_NUMBER, or DISCORD_BOT_TOKEN\n');
  process.exit(1);
}

// Validate LETTA_API_KEY is set for cloud mode
if (!process.env.LETTA_API_KEY) {
  console.error('\n  Error: LETTA_API_KEY is required.');
  console.error('  Get your API key from https://app.letta.com and set it as an environment variable.\n');
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
  console.log(`[Storage] Working directory: ${config.workingDir}`);
  
  // Install feature-gated skills based on enabled features
  // Skills are NOT installed by default - only when their feature is enabled
  const skillsDir = resolve(config.workingDir, '.skills');
  mkdirSync(skillsDir, { recursive: true });
  
  installSkillsToWorkingDir(config.workingDir, {
    cronEnabled: config.cronEnabled,
    googleEnabled: config.polling.gmail.enabled, // Gmail polling uses gog skill
  });
  
  const existingSkills = readdirSync(skillsDir).filter(f => !f.startsWith('.'));
  if (existingSkills.length > 0) {
    console.log(`[Skills] ${existingSkills.length} skill(s) available: ${existingSkills.join(', ')}`);
  }
  
  // Create bot
  const bot = new LettaBot({
    workingDir: config.workingDir,
    model: config.model,
    agentName: process.env.AGENT_NAME || 'LettaBot',
    allowedTools: config.allowedTools,
  });

  const attachmentsDir = resolve(config.workingDir, 'attachments');
  pruneAttachmentsDir(attachmentsDir, config.attachmentsMaxAgeDays).catch((err) => {
    console.warn('[Attachments] Prune failed:', err);
  });
  if (config.attachmentsMaxAgeDays > 0) {
    const timer = setInterval(() => {
      pruneAttachmentsDir(attachmentsDir, config.attachmentsMaxAgeDays).catch((err) => {
        console.warn('[Attachments] Prune failed:', err);
      });
    }, ATTACHMENTS_PRUNE_INTERVAL_MS);
    timer.unref?.();
  }
  
  // Verify agent exists (clear stale ID if deleted)
  let initialStatus = bot.getStatus();
  if (initialStatus.agentId) {
    const exists = await agentExists(initialStatus.agentId);
    if (!exists) {
      console.log(`[Agent] Stored agent ${initialStatus.agentId} not found on server`);
      bot.reset();
      // Also clear env var so search-by-name can run
      delete process.env.LETTA_AGENT_ID;
      initialStatus = bot.getStatus();
    }
  }
  
  // Container deploy: try to find existing agent by name if no ID set
  const agentName = process.env.AGENT_NAME || 'LettaBot';
  if (!initialStatus.agentId && isContainerDeploy) {
    console.log(`[Agent] Searching for existing agent named "${agentName}"...`);
    const found = await findAgentByName(agentName);
    if (found) {
      console.log(`[Agent] Found existing agent: ${found.id}`);
      process.env.LETTA_AGENT_ID = found.id;
      // Reinitialize bot with found agent
      bot.setAgentId(found.id);
      initialStatus = bot.getStatus();
    }
  }
  
  // Agent will be created on first user message (lazy initialization)
  if (!initialStatus.agentId) {
    console.log(`[Agent] No agent found - will create "${agentName}" on first message`);
  }
  
  // Register enabled channels
  if (config.telegram.enabled) {
    const telegram = new TelegramAdapter({
      token: config.telegram.token,
      dmPolicy: config.telegram.dmPolicy,
      allowedUsers: config.telegram.allowedUsers.length > 0 ? config.telegram.allowedUsers : undefined,
      attachmentsDir,
      attachmentsMaxBytes: config.attachmentsMaxBytes,
    });
    bot.registerChannel(telegram);
  }
  
  if (config.slack.enabled) {
    const slack = new SlackAdapter({
      botToken: config.slack.botToken,
      appToken: config.slack.appToken,
      allowedUsers: config.slack.allowedUsers.length > 0 ? config.slack.allowedUsers : undefined,
      attachmentsDir,
      attachmentsMaxBytes: config.attachmentsMaxBytes,
    });
    bot.registerChannel(slack);
  }
  
  if (config.whatsapp.enabled) {
    if (!config.whatsapp.selfChatMode) {
      console.warn('[WhatsApp] WARNING: selfChatMode is OFF - bot will respond to ALL incoming messages!');
      console.warn('[WhatsApp] Only use this if this is a dedicated bot number, not your personal WhatsApp.');
    }
    const whatsapp = new WhatsAppAdapter({
      sessionPath: config.whatsapp.sessionPath,
      dmPolicy: config.whatsapp.dmPolicy,
      allowedUsers: config.whatsapp.allowedUsers.length > 0 ? config.whatsapp.allowedUsers : undefined,
      selfChatMode: config.whatsapp.selfChatMode,
      attachmentsDir,
      attachmentsMaxBytes: config.attachmentsMaxBytes,
    });
    bot.registerChannel(whatsapp);
  }
  
  if (config.signal.enabled) {
    if (!config.signal.selfChatMode) {
      console.warn('[Signal] WARNING: selfChatMode is OFF - bot will respond to ALL incoming messages!');
      console.warn('[Signal] Only use this if this is a dedicated bot number, not your personal Signal.');
    }
    const signal = new SignalAdapter({
      phoneNumber: config.signal.phoneNumber,
      cliPath: config.signal.cliPath,
      httpHost: config.signal.httpHost,
      httpPort: config.signal.httpPort,
      dmPolicy: config.signal.dmPolicy,
      allowedUsers: config.signal.allowedUsers.length > 0 ? config.signal.allowedUsers : undefined,
      selfChatMode: config.signal.selfChatMode,
      attachmentsDir,
      attachmentsMaxBytes: config.attachmentsMaxBytes,
    });
    bot.registerChannel(signal);
  }

  if (config.discord.enabled) {
    const discord = new DiscordAdapter({
      token: config.discord.token,
      dmPolicy: config.discord.dmPolicy,
      allowedUsers: config.discord.allowedUsers.length > 0 ? config.discord.allowedUsers : undefined,
      attachmentsDir,
      attachmentsMaxBytes: config.attachmentsMaxBytes,
    });
    bot.registerChannel(discord);
  }
  
  // Start cron service if enabled
  let cronService: CronService | null = null;
  if (config.cronEnabled) {
    cronService = new CronService(bot, {
      storePath: `${config.workingDir}/cron-jobs.json`,
    });
    await cronService.start();
  }
  
  // Create heartbeat service (always available for /heartbeat command)
  const heartbeatService = new HeartbeatService(bot, {
    enabled: config.heartbeat.enabled,
    intervalMinutes: config.heartbeat.intervalMinutes,
    prompt: config.heartbeat.prompt,
    workingDir: config.workingDir,
    target: config.heartbeat.target,
  });
  
  // Start auto-heartbeats only if interval is configured
  if (config.heartbeat.enabled) {
    heartbeatService.start();
  }
  
  // Wire up /heartbeat command (always available)
  bot.onTriggerHeartbeat = () => heartbeatService.trigger();
  
  // Start polling service if enabled (Gmail, etc.)
  let pollingService: PollingService | null = null;
  if (config.polling.enabled) {
    pollingService = new PollingService(bot, {
      intervalMs: config.polling.intervalMs,
      workingDir: config.workingDir,
      gmail: config.polling.gmail,
    });
    pollingService.start();
  }
  
  // Start all channels
  await bot.start();
  
  // Start health check server (for Railway/Docker health checks)
  // Only exposes "ok" - no sensitive info
  const healthPort = parseInt(process.env.PORT || '8080', 10);
  const healthServer = createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  healthServer.listen(healthPort, () => {
    console.log(`[Health] Listening on :${healthPort}`);
  });
  
  // Log status
  const status = bot.getStatus();
  console.log('\n=================================');
  console.log('LettaBot is running!');
  console.log('=================================');
  console.log(`Agent ID: ${status.agentId || '(will be created on first message)'}`);
  if (isContainerDeploy && status.agentId) {
    console.log(`[Agent] Using agent "${agentName}" (auto-discovered by name)`);
  }
  console.log(`Channels: ${status.channels.join(', ')}`);
  console.log(`Cron: ${config.cronEnabled ? 'enabled' : 'disabled'}`);
  console.log(`Heartbeat: ${config.heartbeat.enabled ? `every ${config.heartbeat.intervalMinutes} min` : 'disabled'}`);
  console.log(`Polling: ${config.polling.enabled ? `every ${config.polling.intervalMs / 1000}s` : 'disabled'}`);
  if (config.polling.gmail.enabled) {
    console.log(`  └─ Gmail: ${config.polling.gmail.account}`);
  }
  if (config.heartbeat.enabled) {
    console.log(`Heartbeat target: ${config.heartbeat.target ? `${config.heartbeat.target.channel}:${config.heartbeat.target.chatId}` : 'last messaged'}`);
  }
  console.log('=================================\n');
  
  // Handle shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    heartbeatService?.stop();
    cronService?.stop();
    await bot.stop();
    process.exit(0);
  };
  
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
