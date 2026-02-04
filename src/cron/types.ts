/**
 * Cron Types
 */

import type { ChannelId } from '../core/types.js';

/**
 * Cron schedule
 */
export type CronSchedule = 
  | { kind: 'cron'; expr: string; tz?: string }  // Cron expression: "0 9 * * *"
  | { kind: 'every'; ms: number }                 // Interval in ms
  | { kind: 'at'; date: Date };                   // One-time at specific date

/**
 * Cron job definition
 */
export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  
  // What to send to the agent
  message: string;
  
  // Optional: Deliver response to a channel
  deliver?: {
    channel: ChannelId;
    chatId: string;
  };
  
  // Delete after running (for one-shot jobs)
  deleteAfterRun?: boolean;
  
  // State
  state: {
    lastRunAt?: Date;
    nextRunAt?: Date;
    lastStatus?: 'ok' | 'error';
    lastError?: string;
    lastResponse?: string;
  };
}

/**
 * Cron job creation input
 */
export type CronJobCreate = Omit<CronJob, 'id' | 'state'>;

/**
 * CronService heartbeat configuration (internal)
 *
 * Different from HeartbeatService config - this uses cron expressions
 * and is managed by CronService as part of the scheduling system.
 */
export interface CronHeartbeatConfig {
  enabled: boolean;

  // Cron schedule (default: every hour)
  schedule: string;

  // Message to send to the agent
  message: string;

  // Deliver response to a channel (optional)
  deliver?: {
    channel: ChannelId;
    chatId: string;
  };
}

/**
 * Default heartbeat messages
 */
export const DEFAULT_HEARTBEAT_MESSAGES = {
  // Simple check-in
  simple: 'Heartbeat check-in. Acknowledge if nothing to report, or share any updates.',
  
  // Morning briefing
  morning: `Good morning! This is your daily check-in. Please:
1. Review any pending tasks or reminders
2. Check for important updates
3. Summarize anything I should know about today
Use acknowledge() if nothing to report.`,
  
  // Periodic status
  status: `Periodic status check. Review your memory and context:
- Any pending items that need attention?
- Any reminders or follow-ups due?
- Any insights or patterns worth noting?
Use acknowledge() if all is well.`,
  
  // Evening wrap-up
  evening: `Evening wrap-up time. Please:
1. Summarize what was accomplished today
2. Note any items to carry forward
3. Flag anything that needs attention tomorrow
Use acknowledge() if nothing significant.`,
};

/**
 * Cron service configuration
 */
export interface CronConfig {
  // Where to store cron jobs
  storePath?: string;

  // Heartbeat configuration (CronService-managed heartbeats using cron expressions)
  heartbeat?: CronHeartbeatConfig;

  // Default timezone for cron expressions
  timezone?: string;

  // Agent name (for agent-scoped state files)
  agentName?: string;
}
