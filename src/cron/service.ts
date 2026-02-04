/**
 * Cron Service - Scheduled tasks
 * 
 * Runs scheduled jobs that send messages to the agent.
 * Supports heartbeat check-ins and agent-managed cron jobs.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, watch, type FSWatcher } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { LettaBot } from '../core/bot.js';
import type { CronJob, CronJobCreate, CronSchedule, CronConfig, HeartbeatConfig } from './types.js';
import { DEFAULT_HEARTBEAT_MESSAGES } from './types.js';
import { getDataDir } from '../utils/paths.js';

// Log file for cron events
const LOG_PATH = resolve(getDataDir(), 'cron-log.jsonl');

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
    // Ignore log errors
  }
  
  console.log(`[Cron] ${event}:`, JSON.stringify(data));
}

// Dynamic import for node-schedule
let schedule: typeof import('node-schedule');

interface CronStoreFile {
  version: 1;
  jobs: CronJob[];
}

const DEFAULT_HEARTBEAT: HeartbeatConfig = {
  enabled: false,
  schedule: '0 * * * *', // Every hour
  message: DEFAULT_HEARTBEAT_MESSAGES.simple,
};

export class CronService {
  private jobs: Map<string, CronJob> = new Map();
  private scheduledJobs: Map<string, import('node-schedule').Job> = new Map();
  private bot: LettaBot;
  private storePath: string;
  private config: CronConfig;
  private started = false;
  private heartbeatJob: import('node-schedule').Job | null = null;
  private fileWatcher: FSWatcher | null = null;
  private lastFileContent: string = '';
  
  constructor(bot: LettaBot, config?: CronConfig) {
    this.bot = bot;
    this.config = config || {};
    this.storePath = config?.storePath 
      ? resolve(getDataDir(), config.storePath)
      : resolve(getDataDir(), 'cron-jobs.json');
    this.loadJobs();
  }
  
  private loadJobs(): void {
    try {
      if (existsSync(this.storePath)) {
        const data: CronStoreFile = JSON.parse(readFileSync(this.storePath, 'utf-8'));
        for (const job of data.jobs) {
          // Restore Date objects
          if (job.state.lastRunAt) {
            job.state.lastRunAt = new Date(job.state.lastRunAt);
          }
          if (job.state.nextRunAt) {
            job.state.nextRunAt = new Date(job.state.nextRunAt);
          }
          this.jobs.set(job.id, job);
        }
        console.log(`[Cron] Loaded ${this.jobs.size} jobs`);
      }
    } catch (e) {
      console.error('[Cron] Failed to load jobs:', e);
    }
  }
  
  private saveJobs(): void {
    try {
      const data: CronStoreFile = {
        version: 1,
        jobs: Array.from(this.jobs.values()),
      };
      // Ensure directory exists (important for Railway volumes)
      mkdirSync(dirname(this.storePath), { recursive: true });
      writeFileSync(this.storePath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('[Cron] Failed to save jobs:', e);
    }
  }
  
  private generateId(): string {
    return `cron-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  
  async start(): Promise<void> {
    if (this.started) return;
    
    // Dynamic import
    schedule = await import('node-schedule');
    
    // Schedule all enabled jobs
    for (const job of this.jobs.values()) {
      if (job.enabled) {
        this.scheduleJob(job);
      }
    }
    
    // Start heartbeat if configured
    const heartbeat = this.config.heartbeat || DEFAULT_HEARTBEAT;
    if (heartbeat.enabled) {
      this.startHeartbeat(heartbeat);
    }
    
    // Start file watcher for hot-reload
    this.startFileWatcher();
    
    this.started = true;
    const enabledCount = Array.from(this.jobs.values()).filter(j => j.enabled).length;
    console.log(`[Cron] Service started (${enabledCount} jobs, heartbeat: ${heartbeat.enabled ? 'on' : 'off'}, watching for changes)`);
  }
  
  stop(): void {
    // Stop file watcher
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
    
    // Cancel all scheduled jobs
    for (const scheduledJob of this.scheduledJobs.values()) {
      scheduledJob.cancel();
    }
    this.scheduledJobs.clear();
    
    // Cancel heartbeat
    if (this.heartbeatJob) {
      this.heartbeatJob.cancel();
      this.heartbeatJob = null;
    }
    
    this.started = false;
    console.log('[Cron] Service stopped');
  }
  
  /**
   * Start watching the cron-jobs.json file for changes
   * This allows the agent to create jobs via CLI and have them scheduled immediately
   */
  private startFileWatcher(): void {
    // Store initial content for comparison
    try {
      if (existsSync(this.storePath)) {
        this.lastFileContent = readFileSync(this.storePath, 'utf-8');
      }
    } catch {
      // Ignore
    }
    
    // Watch for changes
    try {
      this.fileWatcher = watch(this.storePath, { persistent: false }, (eventType) => {
        if (eventType === 'change') {
          this.handleFileChange();
        }
      });
    } catch {
      // File might not exist yet, watch the directory instead
      const dir = resolve(this.storePath, '..');
      this.fileWatcher = watch(dir, { persistent: false }, (eventType, filename) => {
        if (filename === 'cron-jobs.json') {
          this.handleFileChange();
        }
      });
    }
  }
  
  /**
   * Handle changes to the cron-jobs.json file
   */
  private handleFileChange(): void {
    try {
      if (!existsSync(this.storePath)) return;
      
      const newContent = readFileSync(this.storePath, 'utf-8');
      
      // Skip if content hasn't actually changed (debounce)
      if (newContent === this.lastFileContent) return;
      this.lastFileContent = newContent;
      
      logEvent('file_changed', { path: this.storePath });
      
      // Reload jobs
      this.reloadJobs();
    } catch (e) {
      console.error('[Cron] Error handling file change:', e);
    }
  }
  
  /**
   * Reload jobs from disk and reschedule
   */
  private reloadJobs(): void {
    // Cancel all existing scheduled jobs
    for (const scheduledJob of this.scheduledJobs.values()) {
      scheduledJob.cancel();
    }
    this.scheduledJobs.clear();
    this.jobs.clear();
    
    // Reload from disk
    this.loadJobs();
    
    // Reschedule all enabled jobs
    for (const job of this.jobs.values()) {
      if (job.enabled) {
        this.scheduleJob(job);
      }
    }
    
    const enabledCount = Array.from(this.jobs.values()).filter(j => j.enabled).length;
    logEvent('jobs_reloaded', { total: this.jobs.size, enabled: enabledCount });
  }
  
  /**
   * Start the heartbeat check-in (SILENT MODE - no auto-delivery)
   */
  private startHeartbeat(config: HeartbeatConfig): void {
    this.heartbeatJob = schedule.scheduleJob(config.schedule, async () => {
      logEvent('heartbeat_running', { schedule: config.schedule });
      
      try {
        // SILENT MODE - response NOT auto-delivered
        // Agent must use `lettabot-message` CLI to send messages
        const response = await this.bot.sendToAgent(config.message);
        
        console.log(`[Cron] Heartbeat finished (SILENT MODE)`);
        console.log(`  - Response: ${response?.slice(0, 100)}${(response?.length || 0) > 100 ? '...' : ''}`);
        console.log(`  - (Response NOT auto-delivered - agent uses lettabot-message CLI)`);
      } catch (error) {
        console.error('[Cron] Heartbeat failed:', error);
      }
    });
    
    const next = this.heartbeatJob.nextInvocation();
    logEvent('heartbeat_scheduled', {
      schedule: config.schedule,
      nextRun: next?.toISOString() || null,
    });
  }
  
  /**
   * Update heartbeat configuration
   */
  setHeartbeat(config: Partial<HeartbeatConfig>): void {
    const current = this.config.heartbeat || DEFAULT_HEARTBEAT;
    this.config.heartbeat = { ...current, ...config };
    
    // Restart heartbeat if running
    if (this.started) {
      if (this.heartbeatJob) {
        this.heartbeatJob.cancel();
        this.heartbeatJob = null;
      }
      
      if (this.config.heartbeat.enabled) {
        this.startHeartbeat(this.config.heartbeat);
      }
    }
  }
  
  /**
   * Get heartbeat configuration
   */
  getHeartbeat(): HeartbeatConfig {
    return this.config.heartbeat || DEFAULT_HEARTBEAT;
  }
  
  private scheduleJob(job: CronJob): void {
    const rule = this.parseSchedule(job.schedule);
    if (!rule) {
      console.warn(`[Cron] Invalid schedule for job ${job.name}`);
      return;
    }
    
    const scheduledJob = schedule.scheduleJob(rule, async () => {
      await this.runJob(job.id);
    });
    
    if (scheduledJob) {
      this.scheduledJobs.set(job.id, scheduledJob);
      
      // Update next run time
      const nextInvocation = scheduledJob.nextInvocation();
      if (nextInvocation) {
        job.state.nextRunAt = new Date(nextInvocation.getTime());
        this.saveJobs();
        
        console.log(`[Cron] 📅 Scheduled "${job.name}" - next run: ${job.state.nextRunAt.toLocaleString()}`);
        
        logEvent('job_scheduled', {
          id: job.id,
          name: job.name,
          schedule: job.schedule.kind === 'cron' ? job.schedule.expr : job.schedule.kind,
          nextRun: job.state.nextRunAt.toISOString(),
        });
      }
    }
  }
  
  private parseSchedule(sched: CronSchedule): string | Date | import('node-schedule').RecurrenceRule | null {
    switch (sched.kind) {
      case 'cron':
        return sched.expr;
      case 'at':
        return new Date(sched.date);
      case 'every': {
        // For intervals, use RecurrenceRule
        const rule = new schedule.RecurrenceRule();
        // Convert ms to appropriate interval
        const seconds = Math.floor(sched.ms / 1000);
        if (seconds < 60) {
          rule.second = new schedule.Range(0, 59, seconds);
        } else {
          const minutes = Math.floor(seconds / 60);
          rule.minute = new schedule.Range(0, 59, minutes);
        }
        return rule;
      }
      default:
        return null;
    }
  }
  
  private async runJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    
    console.log(`\n${'='.repeat(50)}`);
    const isEmailCheck = job.name.toLowerCase().includes('email') || job.message.includes('gog gmail');
    const icon = isEmailCheck ? '📧' : '⏰';
    console.log(`[Cron] ${icon} RUNNING JOB: ${job.name}`);
    console.log(`       ID: ${job.id}`);
    if (isEmailCheck) {
      console.log(`       Checking Gmail for new messages...`);
    } else {
      console.log(`       Message: ${job.message.slice(0, 100)}${job.message.length > 100 ? '...' : ''}`);
    }
    console.log(`${'='.repeat(50)}\n`);
    
    logEvent('job_running', { id: job.id, name: job.name });
    
    try {
      // Format message with metadata
      const now = new Date();
      const formattedTime = now.toLocaleString();
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const messageWithMetadata = [
        `[cron:${job.id} ${job.name}] ${job.message}`,
        `Current time: ${formattedTime} (${timezone})`,
      ].join('\n');
      
      // Send message to agent (SILENT MODE - response NOT auto-delivered)
      // Agent must use `lettabot-message` CLI to send messages explicitly
      const response = await this.bot.sendToAgent(messageWithMetadata);
      
      // Update state
      job.state.lastRunAt = new Date();
      job.state.lastStatus = 'ok';
      job.state.lastError = undefined;
      job.state.lastResponse = response?.slice(0, 500); // Store truncated response
      
      // Update next run time
      const scheduled = this.scheduledJobs.get(jobId);
      if (scheduled) {
        const next = scheduled.nextInvocation();
        if (next) {
          job.state.nextRunAt = new Date(next.getTime());
        }
      }
      
      console.log(`\n${'='.repeat(50)}`);
      console.log(`[Cron] ✅ JOB COMPLETED: ${job.name} [SILENT MODE]`);
      console.log(`       Response: ${response?.slice(0, 200)}${(response?.length || 0) > 200 ? '...' : ''}`);
      console.log(`       (Response NOT auto-delivered - agent uses lettabot-message CLI)`);
      console.log(`${'='.repeat(50)}\n`);
      
      logEvent('job_completed', {
        id: job.id,
        name: job.name,
        status: 'ok',
        mode: 'silent',
        nextRun: job.state.nextRunAt?.toISOString(),
        responseLength: response?.length || 0,
      });
      
      // Delete if one-shot
      if (job.deleteAfterRun) {
        this.remove(jobId);
      } else {
        this.saveJobs();
      }
      
    } catch (error) {
      logEvent('job_failed', {
        id: job.id,
        name: job.name,
        error: error instanceof Error ? error.message : String(error),
      });
      job.state.lastRunAt = new Date();
      job.state.lastStatus = 'error';
      job.state.lastError = error instanceof Error ? error.message : String(error);
      this.saveJobs();
    }
  }
  
  // Public API
  
  add(input: CronJobCreate): CronJob {
    const job: CronJob = {
      ...input,
      id: this.generateId(),
      state: {},
    };
    
    this.jobs.set(job.id, job);
    this.saveJobs();
    
    if (this.started && job.enabled) {
      this.scheduleJob(job);
    }
    
    console.log(`[Cron] Added job: ${job.name}`);
    return job;
  }
  
  remove(jobId: string): boolean {
    const scheduledJob = this.scheduledJobs.get(jobId);
    if (scheduledJob) {
      scheduledJob.cancel();
      this.scheduledJobs.delete(jobId);
    }
    
    const deleted = this.jobs.delete(jobId);
    if (deleted) {
      this.saveJobs();
      console.log(`[Cron] Removed job: ${jobId}`);
    }
    return deleted;
  }
  
  enable(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    
    job.enabled = true;
    this.saveJobs();
    
    if (this.started) {
      this.scheduleJob(job);
    }
  }
  
  disable(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    
    job.enabled = false;
    this.saveJobs();
    
    const scheduledJob = this.scheduledJobs.get(jobId);
    if (scheduledJob) {
      scheduledJob.cancel();
      this.scheduledJobs.delete(jobId);
    }
  }
  
  list(): CronJob[] {
    return Array.from(this.jobs.values());
  }
  
  get(jobId: string): CronJob | undefined {
    return this.jobs.get(jobId);
  }
  
  /**
   * Run a job immediately (for testing)
   */
  async runNow(jobId: string): Promise<void> {
    await this.runJob(jobId);
  }
  
  /**
   * Get service status
   */
  getStatus(): {
    running: boolean;
    totalJobs: number;
    enabledJobs: number;
    heartbeat: HeartbeatConfig;
  } {
    const jobs = Array.from(this.jobs.values());
    return {
      running: this.started,
      totalJobs: jobs.length,
      enabledJobs: jobs.filter(j => j.enabled).length,
      heartbeat: this.getHeartbeat(),
    };
  }
}
