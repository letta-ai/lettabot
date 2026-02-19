/**
 * Heartbeat Service
 * 
 * Sends periodic heartbeats to wake the agent up on a schedule.
 * 
 * SILENT MODE: Agent's text output is NOT auto-delivered.
 * The agent must use `lettabot-message` CLI via Bash to contact the user.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { AgentSession } from '../core/interfaces.js';
import type { TriggerContext } from '../core/types.js';
import { buildHeartbeatPrompt, buildCustomHeartbeatPrompt } from '../core/prompts.js';
import { getCronLogPath } from '../utils/paths.js';
import { listActionableTodos } from '../todo/store.js';


// Log file
const LOG_PATH = getCronLogPath();

function logEvent(event: string, data: Record<string, unknown>): void {
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
  
  console.log(`[Heartbeat] ${event}:`, JSON.stringify(data));
}

/**
 * Heartbeat configuration
 */
export interface HeartbeatConfig {
  enabled: boolean;
  intervalMinutes: number;
  skipRecentUserMinutes?: number; // Default 5. Set to 0 to disable skip logic.
  workingDir: string;
  agentKey: string;
  
  // Custom heartbeat prompt (optional)
  prompt?: string;
  
  // Path to prompt file (re-read each tick for live editing)
  promptFile?: string;
  
  // Target for delivery (optional - defaults to last messaged)
  target?: {
    channel: string;
    chatId: string;
  };
}

/**
 * Heartbeat Service
 */
export class HeartbeatService {
  private bot: AgentSession;
  private config: HeartbeatConfig;
  private intervalId: NodeJS.Timeout | null = null;
  
  constructor(bot: AgentSession, config: HeartbeatConfig) {
    this.bot = bot;
    this.config = config;
  }

  private getSkipWindowMs(): number {
    const raw = this.config.skipRecentUserMinutes;
    if (raw === undefined || !Number.isFinite(raw) || raw < 0) {
      return 5 * 60 * 1000; // default: 5 minutes
    }
    return Math.floor(raw * 60 * 1000);
  }
  
  /**
   * Start the heartbeat timer
   */
  start(): void {
    if (!this.config.enabled) {
      console.log('[Heartbeat] Disabled');
      return;
    }
    
    if (this.intervalId) {
      console.log('[Heartbeat] Already running');
      return;
    }
    
    const intervalMs = this.config.intervalMinutes * 60 * 1000;
    
    console.log(`[Heartbeat] Starting in SILENT MODE (every ${this.config.intervalMinutes} minutes)`);
    console.log(`[Heartbeat] First heartbeat in ${this.config.intervalMinutes} minutes`);
    
    // Wait full interval before first heartbeat (don't fire on startup)
    this.intervalId = setInterval(() => this.runHeartbeat(), intervalMs);
    
    logEvent('heartbeat_started', {
      intervalMinutes: this.config.intervalMinutes,
      mode: 'silent',
      note: 'Agent must use lettabot-message CLI to contact user',
    });
  }
  
  /**
   * Stop the heartbeat timer
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[Heartbeat] Stopped');
    }
  }
  
  /**
   * Manually trigger a heartbeat (for /heartbeat command)
   * Bypasses the "recently messaged" check since user explicitly requested it
   */
  async trigger(): Promise<void> {
    console.log('[Heartbeat] Manual trigger requested');
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
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Heartbeat] ⏰ RUNNING at ${formattedTime} [SILENT MODE]`);
    console.log(`${'='.repeat(60)}\n`);
    
    // Skip if user sent a message in the configured window (unless manual trigger)
    if (!skipRecentCheck) {
      const skipWindowMs = this.getSkipWindowMs();
      const lastUserMessage = this.bot.getLastUserMessageTime();
      if (skipWindowMs > 0 && lastUserMessage) {
        const msSinceLastMessage = now.getTime() - lastUserMessage.getTime();
        
        if (msSinceLastMessage < skipWindowMs) {
          const minutesAgo = Math.round(msSinceLastMessage / 60000);
          console.log(`[Heartbeat] User messaged ${minutesAgo}m ago - skipping heartbeat`);
          logEvent('heartbeat_skipped_recent_user', {
            lastUserMessage: lastUserMessage.toISOString(),
            minutesAgo,
          });
          return;
        }
      }
    }
    
    console.log(`[Heartbeat] Sending heartbeat to agent...`);
    
    logEvent('heartbeat_running', { 
      time: now.toISOString(),
      mode: 'silent',
    });
    
    // Build trigger context for silent mode
    const lastTarget = this.bot.getLastMessageTarget();
    const triggerContext: TriggerContext = {
      type: 'heartbeat',
      outputMode: 'silent',
      sourceChannel: lastTarget?.channel,
      sourceChatId: lastTarget?.chatId,
    };
    
    try {
      const todoAgentKey = this.bot.getStatus().agentId || this.config.agentKey;
      const actionableTodos = listActionableTodos(todoAgentKey, now);
      if (actionableTodos.length > 0) {
        console.log(`[Heartbeat] Loaded ${actionableTodos.length} actionable to-do(s).`);
      }

      // Resolve custom prompt: inline config > promptFile (re-read each tick) > default
      let customPrompt = this.config.prompt;
      if (!customPrompt && this.config.promptFile) {
        try {
          const promptPath = resolve(this.config.workingDir, this.config.promptFile);
          customPrompt = readFileSync(promptPath, 'utf-8').trim();
        } catch (err) {
          console.error(`[Heartbeat] Failed to read promptFile "${this.config.promptFile}":`, err);
        }
      }

      const message = customPrompt
        ? buildCustomHeartbeatPrompt(customPrompt, formattedTime, timezone, this.config.intervalMinutes, actionableTodos, now)
        : buildHeartbeatPrompt(formattedTime, timezone, this.config.intervalMinutes, actionableTodos, now);
      
      console.log(`[Heartbeat] Sending prompt (SILENT MODE):\n${'─'.repeat(50)}\n${message}\n${'─'.repeat(50)}\n`);
      
      // Send to agent - response text is NOT delivered (silent mode)
      // Agent must use `lettabot-message` CLI via Bash to send messages
      const response = await this.bot.sendToAgent(message, triggerContext);
      
      // Log results
      console.log(`[Heartbeat] Agent finished.`);
      console.log(`  - Response text: ${response?.length || 0} chars (NOT delivered - silent mode)`);
      
      if (response && response.trim()) {
        console.log(`  - Response preview: "${response.slice(0, 100)}${response.length > 100 ? '...' : ''}"`);
      }
      
      logEvent('heartbeat_completed', {
        mode: 'silent',
        responseLength: response?.length || 0,
      });
      
    } catch (error) {
      console.error('[Heartbeat] Error:', error);
      logEvent('heartbeat_error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
