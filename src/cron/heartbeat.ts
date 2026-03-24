/**
 * Heartbeat Service
 * 
 * Sends periodic heartbeats to wake the agent up on a schedule.
 * 
 * SILENT MODE: Agent's text output is NOT auto-delivered.
 * The agent must use `lettabot-message` CLI via Bash to contact the user.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { AgentSession } from '../core/interfaces.js';
import type { TriggerContext } from '../core/types.js';
import { buildHeartbeatPrompt, buildCustomHeartbeatPrompt } from '../core/prompts.js';
import { getCronLogPath } from '../utils/paths.js';
import { listActionableTodos } from '../todo/store.js';


import { createLogger, type Logger } from '../logger.js';

const log = createLogger('Heartbeat');
// Log file
const LOG_PATH = getCronLogPath();

function logEvent(event: string, data: Record<string, unknown>, logger: Logger = log): void {
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    ...data,
  };
  
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
  } catch {
    // Ignore
  }
  
  logger.info(`${event}:`, JSON.stringify(data));
}

/**
 * Heartbeat configuration
 */
export interface HeartbeatConfig {
  enabled: boolean;
  intervalMinutes: number;
  skipRecentUserMinutes?: number; // Default 5. Set to 0 to disable skip logic.
  skipRecentPolicy?: 'fixed' | 'fraction' | 'off';
  skipRecentFraction?: number; // Used when policy=fraction. Expected range: 0-1.
  workingDir: string;
  agentKey: string;
  
  // Whether memfs (git-backed memory filesystem) is enabled for this agent
  memfs?: boolean;
  
  // Custom heartbeat prompt (optional)
  prompt?: string;
  
  // Path to prompt file (re-read each tick for live editing)
  promptFile?: string;
  
  // Target for delivery (optional - defaults to last messaged)
  target?: {
    channel: string;
    chatId: string;
  };

  // Bot name for log context
  botName?: string;
}

/**
 * Heartbeat Service
 */
export class HeartbeatService {
  private readonly log;
  private bot: AgentSession;
  private config: HeartbeatConfig;
  private intervalId: NodeJS.Timeout | null = null;
  
  constructor(bot: AgentSession, config: HeartbeatConfig) {
    this.bot = bot;
    this.config = config;
    this.log = createLogger('Heartbeat', config.botName);
  }

  private getSkipRecentPolicy(): 'fixed' | 'fraction' | 'off' {
    const configured = this.config.skipRecentPolicy;
    if (configured === 'fixed' || configured === 'fraction' || configured === 'off') {
      return configured;
    }

    // Backward compatibility: if explicit minutes are configured, preserve the
    // historical fixed-window behavior unless policy is explicitly set.
    if (this.config.skipRecentUserMinutes !== undefined) {
      return 'fixed';
    }

    // New default: skip for half the heartbeat interval.
    return 'fraction';
  }

  private getSkipWindow(): { policy: 'fixed' | 'fraction' | 'off'; minutes: number; milliseconds: number } {
    const policy = this.getSkipRecentPolicy();

    if (policy === 'off') {
      return { policy, minutes: 0, milliseconds: 0 };
    }

    if (policy === 'fraction') {
      const rawFraction = this.config.skipRecentFraction;
      const fraction = rawFraction !== undefined && Number.isFinite(rawFraction)
        ? Math.max(0, Math.min(1, rawFraction))
        : 0.5;
      const minutes = Math.ceil(Math.max(0, this.config.intervalMinutes) * fraction);
      return {
        policy,
        minutes,
        milliseconds: Math.floor(minutes * 60 * 1000),
      };
    }

    const raw = this.config.skipRecentUserMinutes;
    const minutes = (raw === undefined || !Number.isFinite(raw) || raw < 0)
      ? 5
      : raw;
    return {
      policy,
      minutes,
      milliseconds: Math.floor(minutes * 60 * 1000),
    };
  }

  /**
   * Resolve the memory directory for this agent.
   * Returns null if memfs is disabled or agent ID is unavailable.
   */
  private getMemoryDir(): string | null {
    if (!this.config.memfs) return null;
    const agentId = this.bot.getStatus().agentId;
    if (!agentId) return null;
    return join(homedir(), '.letta', 'agents', agentId, 'memory');
  }

  /**
   * Check if the memfs git repo has untracked or uncommitted files.
   * Logs a warning if it does. Non-fatal: heartbeat proceeds regardless.
   */
  private checkMemfsHealth(): void {
    const memoryDir = this.getMemoryDir();
    if (!memoryDir) return;

    if (!existsSync(memoryDir)) {
      this.log.debug(`Memory directory does not exist yet: ${memoryDir}`);
      return;
    }

    try {
      const output = execFileSync('git', ['status', '--porcelain'], {
        cwd: memoryDir,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();

      if (output) {
        const lines = output.split('\n');
        this.log.warn(
          `Memory directory has ${lines.length} uncommitted/untracked file(s). ` +
          `This may cause heartbeat failures. Run "cd ${memoryDir} && git add -A && git commit -m 'sync'" to fix. ` +
          `Files: ${lines.slice(0, 5).join(', ')}${lines.length > 5 ? ` (and ${lines.length - 5} more)` : ''}`,
        );
        logEvent('heartbeat_memfs_dirty', {
          memoryDir,
          fileCount: lines.length,
          files: lines.slice(0, 10),
        }, this.log);
      }
    } catch (err) {
      this.log.warn(
        `Failed to check memfs health in ${memoryDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  
  /**
   * Start the heartbeat timer
   */
  start(): void {
    if (!this.config.enabled) {
      this.log.info('Disabled');
      return;
    }
    
    if (this.intervalId) {
      this.log.info('Already running');
      return;
    }
    
    const intervalMs = this.config.intervalMinutes * 60 * 1000;
    
    this.log.info(`Starting in SILENT MODE (every ${this.config.intervalMinutes} minutes)`);
    this.log.info(`First heartbeat in ${this.config.intervalMinutes} minutes`);
    
    // Wait full interval before first heartbeat (don't fire on startup)
    this.intervalId = setInterval(() => this.runHeartbeat(), intervalMs);
    
    logEvent('heartbeat_started', {
      intervalMinutes: this.config.intervalMinutes,
      mode: 'silent',
      note: 'Agent must use lettabot-message CLI to contact user',
    }, this.log);
  }
  
  /**
   * Stop the heartbeat timer
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.log.info('Stopped');
    }
  }
  
  /**
   * Manually trigger a heartbeat (for /heartbeat command)
   * Bypasses the "recently messaged" check since user explicitly requested it
   */
  async trigger(): Promise<void> {
    this.log.info('Manual trigger requested');
    await this.runHeartbeat(true); // skipRecentCheck = true
  }
  
  /**
   * Run a single heartbeat
   * 
   * SILENT MODE: Agent's text output is NOT auto-delivered.
   * The agent must use `lettabot-message` CLI via Bash to contact the user.
   * 
   * @param skipRecentCheck - If true, bypass the "recently messaged" check (for manual triggers)
   */
  private async runHeartbeat(skipRecentCheck = false): Promise<void> {
    const now = new Date();
    const formattedTime = now.toLocaleString();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    
    this.log.info(`${'='.repeat(60)}`);
    this.log.info(`⏰ RUNNING at ${formattedTime} [SILENT MODE]`);
    this.log.info(`${'='.repeat(60)}`);
    
    // Skip if user sent a message in the configured window (unless manual trigger)
    if (!skipRecentCheck) {
      const { policy, minutes: skipWindowMin, milliseconds: skipWindowMs } = this.getSkipWindow();
      const lastUserMessage = this.bot.getLastUserMessageTime();
      if (skipWindowMs > 0 && lastUserMessage) {
        const msSinceLastMessage = now.getTime() - lastUserMessage.getTime();
        
        if (msSinceLastMessage < skipWindowMs) {
          const minutesAgo = Math.round(msSinceLastMessage / 60000);
          this.log.info(`User messaged ${minutesAgo}m ago - skipping heartbeat (policy=${policy}, window=${skipWindowMin}m)`);
          logEvent('heartbeat_skipped_recent_user', {
            lastUserMessage: lastUserMessage.toISOString(),
            minutesAgo,
            skipPolicy: policy,
            skipWindowMin,
          }, this.log);
          return;
        }
      }
    }
    
    // Pre-flight: check for dirty memfs state that could cause session init failures
    this.checkMemfsHealth();

    this.log.info(`Sending heartbeat to agent...`);
    
    logEvent('heartbeat_running', { 
      time: now.toISOString(),
      mode: 'silent',
    }, this.log);
    
    // Build trigger context for silent mode
    const triggerContext: TriggerContext = {
      type: 'heartbeat',
      outputMode: 'silent',
    };
    
    try {
      const todoAgentKey = this.bot.getStatus().agentId || this.config.agentKey;
      const actionableTodos = listActionableTodos(todoAgentKey, now);
      if (actionableTodos.length > 0) {
        this.log.info(`Loaded ${actionableTodos.length} actionable to-do(s).`);
      }

      // Resolve custom prompt: inline config > promptFile (re-read each tick) > default
      let customPrompt = this.config.prompt;
      if (!customPrompt && this.config.promptFile) {
        try {
          const promptPath = resolve(this.config.workingDir, this.config.promptFile);
          customPrompt = readFileSync(promptPath, 'utf-8').trim();
        } catch (err) {
          this.log.error(`Failed to read promptFile "${this.config.promptFile}":`, err);
        }
      }

      const message = customPrompt
        ? buildCustomHeartbeatPrompt(customPrompt, formattedTime, timezone, this.config.intervalMinutes, actionableTodos, now)
        : buildHeartbeatPrompt(formattedTime, timezone, this.config.intervalMinutes, actionableTodos, now);
      
      this.log.info(`Sending prompt (SILENT MODE):\n${'─'.repeat(50)}\n${message}\n${'─'.repeat(50)}\n`);
      
      // Send to agent - response text is NOT delivered (silent mode)
      // Agent must use `lettabot-message` CLI via Bash to send messages
      const response = await this.bot.sendToAgent(message, triggerContext);
      
      // Log results
      this.log.info(`Agent finished.`);
      this.log.info(`  - Response text: ${response?.length || 0} chars (NOT delivered - silent mode)`);
      
      if (response && response.trim()) {
        this.log.info(`  - Response preview: "${response.slice(0, 100)}${response.length > 100 ? '...' : ''}"`);
      }
      
      logEvent('heartbeat_completed', {
        mode: 'silent',
        responseLength: response?.length || 0,
      }, this.log);
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error('Error:', error);

      // Surface git/memfs-related errors with actionable diagnostics
      if (/\b(git|memfs|memory)\b/i.test(errorMsg)) {
        const memoryDir = this.getMemoryDir();
        this.log.warn(
          `Heartbeat failed due to a git/memfs error. ` +
          `This often happens when the memory directory has untracked or uncommitted files. ` +
          (memoryDir
            ? `Check: cd ${memoryDir} && git status`
            : `Enable memfs or check LETTA_AGENT_ID to diagnose.`),
        );
      }

      logEvent('heartbeat_error', { error: errorMsg }, this.log);
    }
  }
}
