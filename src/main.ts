/**
 * LettaBot - Multi-Channel AI Assistant
 * 
 * Single agent, single conversation across all channels.
 * Chat continues seamlessly between Telegram, Slack, and WhatsApp.
 */

import { existsSync, mkdirSync, promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';

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
  wasLoadedFromFleetConfig,
} from './config/index.js';
import { getCronDataDir, getDataDir, getWorkingDir, hasRailwayVolume, resolveWorkingDirPath } from './utils/paths.js';
import { parseCsvList, parseNonNegativeNumber } from './utils/parse.js';
import { createLogger, setLogLevel } from './logger.js';
import { loadStoredAgentId, refreshTokensIfNeeded, withDiscoveryLock } from './startup/bootstrap.js';

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

const STORE_PATH = resolve(getDataDir(), 'lettabot-agent.json');
const currentBaseUrl = process.env.LETTA_BASE_URL || 'https://api.letta.com';
loadStoredAgentId(STORE_PATH, currentBaseUrl);
await refreshTokensIfNeeded();

import { normalizeAgents } from './config/types.js';
import { LettaGateway } from './core/gateway.js';
import { LettaBot } from './core/bot.js';
import type { Store } from './core/store.js';
import { createChannelsForAgent } from './channels/factory.js';
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
  5. ./agents.yml (fleet config from lettactl)
  6. ./agents.yaml
  7. ~/.lettabot/config.yaml (user global)
  8. ~/.lettabot/config.yml

Run "lettabot onboard" to create a config, set LETTABOT_CONFIG_YAML for cloud deploys,
or use an agents.yml from lettactl with a lettabot: section.
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
  log.error('  Get your API key from https://app.letta.com/projects/default-project/api-keys and set it as an environment variable.');
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
  const agentStores = new Map<string, Store>();
  const sessionInvalidators = new Map<string, (key?: string) => void>();
  const agentChannelMap = new Map<string, string[]>();
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
    const configuredSleeptime = agentConfig.features?.sleeptime;
    // Treat missing trigger as active (conservative): only `trigger: 'off'` explicitly disables.
    const sleeptimeRequiresMemfs = !!configuredSleeptime && configuredSleeptime.trigger !== 'off';
    const effectiveSleeptime = !resolvedMemfs && sleeptimeRequiresMemfs
      ? undefined
      : configuredSleeptime;

    if (!resolvedMemfs && sleeptimeRequiresMemfs) {
      log.warn(
        `Agent ${agentConfig.name}: sleeptime is configured but memfs is disabled; ` +
        `sleeptime will be ignored. Enable features.memfs (or LETTABOT_MEMFS=true) to use sleeptime.`
      );
    }

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
      sleeptime: effectiveSleeptime,
      display: agentConfig.features?.display,
      conversationMode: agentConfig.conversations?.mode || 'shared',
      heartbeatConversation: agentConfig.conversations?.heartbeat || 'last-active',
      conversationOverrides: agentConfig.conversations?.perChannel,
      maxSessions: agentConfig.conversations?.maxSessions,
      reuseSession: agentConfig.conversations?.reuseSession,
      redaction: agentConfig.security?.redaction,
      cronStorePath,
      skills: {
        cronEnabled: agentConfig.features?.cron ?? globalConfig.cronEnabled,
        googleEnabled: !!agentConfig.integrations?.google?.enabled || !!agentConfig.polling?.gmail?.enabled,
        blueskyEnabled: !!agentConfig.channels?.bluesky?.enabled,
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

    // Discover by name under an inter-process lock to avoid startup races.
    // Fleet configs rely on pre-created agents from lettactl apply.
    if (!initialStatus.agentId && (isContainerDeploy || wasLoadedFromFleetConfig())) {
      try {
        await withDiscoveryLock(STORE_PATH, agentConfig.name, async () => {
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
      intervalMinutes: heartbeatConfig?.intervalMin ?? 240,
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
        gmail: {
          enabled: gmailEnabled,
          accounts: gmailAccounts,
          prompt: agentConfig.polling?.gmail?.prompt,
          promptFile: agentConfig.polling?.gmail?.promptFile,
        },
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
    agentStores.set(agentConfig.name, bot.store);
    sessionInvalidators.set(agentConfig.name, (key) => bot.invalidateSession(key));
    agentChannelMap.set(agentConfig.name, adapters.map(a => a.id));
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
    stores: agentStores,
    agentChannels: agentChannelMap,
    sessionInvalidators,
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
        heartbeatIntervalMin: hbCfg?.enabled ? (hbCfg.intervalMin ?? 240) : undefined,
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
    apiServer.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  log.error('Fatal error:', e);
  process.exit(1);
});
